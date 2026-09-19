import { Avatar, type AvatarProps } from '@/components/admin/Avatar'

/**
 * `Avatar` pointed at the HRMS file route.
 *
 * A wrapper rather than a `fileBasePath` prop repeated at every call site: on
 * hrms.crowd4test.com `proxy.ts` rewrites every path under `/hrms`, so the
 * platform's default `/app/files/...` becomes `/hrms/app/files/...` and 404s —
 * which is why no uploaded picture ever appeared in HRMS. Getting that wrong
 * on one new page would silently break pictures on it alone, so the path is
 * set in one place and HRMS pages use this.
 */
export function HrAvatar(props: Omit<AvatarProps, 'fileBasePath'>) {
  return <Avatar {...props} fileBasePath="/files" />
}
