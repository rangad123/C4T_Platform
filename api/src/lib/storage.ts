import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../config/env.js'
import { BadRequestError } from './errors.js'

/**
 * Storage abstraction with two drivers:
 *   local — dev only, writes under LOCAL_STORAGE_DIR
 *   s3    — production, presigned PUT so large bug videos never transit the API
 *
 * The presign pattern matters here: §2.3 lets Testers attach screenshots and
 * files to bug reports. Proxying those through EC2 would burn memory and
 * bandwidth on the API box for no benefit.
 */

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'application/zip',
  'application/x-zip-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

let s3: S3Client | null = null
function client(): S3Client {
  s3 ??= new S3Client({
    region: env.AWS_REGION,
    // Omitting credentials lets the SDK use the EC2 instance IAM role.
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          },
        }
      : {}),
    // S3-compatible stores (Cloudflare R2, Backblaze B2, MinIO) require a
    // custom endpoint and path-style addressing. AWS itself ignores this.
    ...(env.S3_BUCKET_ENDPOINT
      ? {
          endpoint: env.S3_BUCKET_ENDPOINT,
          forcePathStyle: true,
        }
      : {}),
  })
  return s3
}

export function assertUploadAllowed(mimeType: string, sizeBytes: number): void {
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new BadRequestError(`File type "${mimeType}" is not allowed`)
  }
  if (sizeBytes <= 0 || sizeBytes > env.UPLOAD_MAX_BYTES) {
    const maxMb = Math.floor(env.UPLOAD_MAX_BYTES / 1_048_576)
    throw new BadRequestError(`File must be between 1 byte and ${maxMb} MB`)
  }
}

/** Builds a collision-proof, non-guessable storage key. */
export function buildStorageKey(scope: string, originalName: string): string {
  const ext = path.extname(originalName).slice(0, 12).toLowerCase()
  const safeExt = /^\.[a-z0-9]+$/.test(ext) ? ext : ''
  const now = new Date()
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${scope.toLowerCase()}/${yyyy}/${mm}/${crypto.randomUUID()}${safeExt}`
}

export interface PresignedUpload {
  uploadUrl: string
  storageKey: string
  driver: 'local' | 's3'
  expiresInSeconds: number
  /** Headers the client MUST send with the PUT for the signature to match. */
  requiredHeaders: Record<string, string>
}

export async function createUploadUrl(params: {
  scope: string
  originalName: string
  mimeType: string
  sizeBytes: number
}): Promise<PresignedUpload> {
  assertUploadAllowed(params.mimeType, params.sizeBytes)
  const storageKey = buildStorageKey(params.scope, params.originalName)

  if (env.STORAGE_DRIVER === 'local') {
    // Dev fallback: the client PUTs to our own endpoint instead of S3.
    return {
      uploadUrl: `${env.API_PUBLIC_URL}/v1/uploads/local/${encodeURIComponent(storageKey)}`,
      storageKey,
      driver: 'local',
      expiresInSeconds: env.UPLOAD_URL_TTL_SECONDS,
      requiredHeaders: { 'content-type': params.mimeType },
    }
  }

  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET!,
    Key: storageKey,
    ContentType: params.mimeType,
    ContentLength: params.sizeBytes,
  })
  const uploadUrl = await getSignedUrl(client(), command, {
    expiresIn: env.UPLOAD_URL_TTL_SECONDS,
  })

  return {
    uploadUrl,
    storageKey,
    driver: 's3',
    expiresInSeconds: env.UPLOAD_URL_TTL_SECONDS,
    requiredHeaders: {
      'content-type': params.mimeType,
      'content-length': String(params.sizeBytes),
    },
  }
}

/** Short-lived download URL. Objects are never public-read. */
export async function createDownloadUrl(storageKey: string, filename?: string): Promise<string> {
  if (env.STORAGE_DRIVER === 'local') {
    return `${env.API_PUBLIC_URL}/v1/uploads/local/${encodeURIComponent(storageKey)}`
  }
  const command = new GetObjectCommand({
    Bucket: env.S3_BUCKET!,
    Key: storageKey,
    ...(filename
      ? { ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, '')}"` }
      : {}),
  })
  return getSignedUrl(client(), command, { expiresIn: env.UPLOAD_URL_TTL_SECONDS })
}

export async function deleteObject(storageKey: string): Promise<void> {
  if (env.STORAGE_DRIVER === 'local') {
    const full = path.resolve(env.LOCAL_STORAGE_DIR, storageKey)
    await fs.rm(full, { force: true })
    return
  }
  await client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET!, Key: storageKey }))
}

// ─── Local driver helpers (development only) ─────────────────────────────────

export async function writeLocalObject(storageKey: string, data: Buffer): Promise<void> {
  const full = path.resolve(env.LOCAL_STORAGE_DIR, storageKey)
  if (!full.startsWith(path.resolve(env.LOCAL_STORAGE_DIR))) {
    throw new BadRequestError('Invalid storage key')
  }
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, data)
}

export async function readLocalObject(storageKey: string): Promise<Buffer> {
  const full = path.resolve(env.LOCAL_STORAGE_DIR, storageKey)
  if (!full.startsWith(path.resolve(env.LOCAL_STORAGE_DIR))) {
    throw new BadRequestError('Invalid storage key')
  }
  return fs.readFile(full)
}
