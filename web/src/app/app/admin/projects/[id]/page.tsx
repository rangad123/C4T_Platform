import type { ReactNode } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList, type DescriptionItem } from '@/components/admin/DescriptionList'
import { StatusBadge, SeverityBadge, RoleBadge } from '@/components/admin/StatusBadge'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { serverFetch, serverFetchOrNull } from '@/lib/api/server'
import { loadList } from '@/lib/admin/list'
import { requireRole, hasPermission } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'
import { formatDate, personName, titleCase } from '@/lib/admin/format'
import {
  ASSIGNMENT_STATUSES,
  PROJECT_PRIORITIES,
  allowedTransitions,
  deviceFitsTargets,
  isProjectPriority,
  type ProjectAssignmentRow,
  type ProjectBugRow,
  type ProjectDetail,
  type ProjectMaterial,
  type VerifiedTesterRow,
} from './constants'
import {
  addFeature,
  addMaterial,
  archiveProject,
  changeProjectStatus,
  inviteTesters,
  removeFeature,
  removeMaterial,
  updateAssignment,
  updateProjectBrief,
  updateProjectDelivery,
} from './actions'

/**
 * `/app/admin/projects/[id]` — the project workbench (§2.2 Project Management).
 *
 * Every panel is one form and one API call, so a failed save only ever loses the
 * fields in that panel. The split between the wide column and the aside is by
 * volume, not importance: the status control is the most consequential thing on
 * the page and still sits in the aside, because it is one select.
 *
 * There is no client JavaScript here. Each form is a plain
 * `<form action={serverAction}>` with a hidden id, which means the page works
 * before hydration and needs no error-boundary-shaped client state.
 */

/** Verified testers offered per invite. Well under the API's 200-id ceiling. */
const TESTER_POOL_SIZE = 40
/** Bugs shown inline. The full set lives on the bugs list. */
const BUG_PREVIEW_SIZE = 10

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRole(['ADMIN', 'SUB_ADMIN'])
  const { id } = await params

  let project: ProjectDetail | null = null
  let loadError: 'forbidden' | 'unknown' | null = null

  try {
    // `serverFetch` unwraps the `{ data }` envelope — this IS the project.
    project = await serverFetch<ProjectDetail>(`projects/${id}`)
  } catch (err) {
    // The API returns 404 rather than 403 when a project is out of scope, so a
    // genuine 404 and "not yours" are the same page by design.
    if (err instanceof ApiError && err.status === 404) notFound()
    if (err instanceof ApiError && err.status === 403) loadError = 'forbidden'
    else loadError = 'unknown'
  }

  if (loadError !== null || project === null) {
    return (
      <DetailShell
        crumbs={[
          { label: 'Projects', href: '/app/admin/projects' },
          { label: loadError === 'forbidden' ? 'Restricted' : 'Unavailable' },
        ]}
        eyebrow="Delivery"
        title={loadError === 'forbidden' ? 'Restricted' : 'Unavailable'}
      >
        {loadError === 'forbidden' ? (
          <EmptyState
            icon="lock"
            title="You don't have access to this project"
            description="Ask an administrator to grant you the project.read permission."
            action={
              <Button variant="secondary" href="/app/admin/projects">
                Back to projects
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon="alert-triangle"
            title="Couldn't load this project"
            description="The projects service is unreachable. Refresh in a moment."
            action={
              <Button variant="secondary" href="/app/admin/projects">
                Back to projects
              </Button>
            }
          />
        )}
      </DetailShell>
    )
  }

  const canDelete = hasPermission(user, 'project.delete')
  const { capabilities } = project

  // Both lists are read in parallel with each other; the project read above had
  // to come first because a 404 there means there is no page to fill in.
  const [testerPool, bugs, features] = await Promise.all([
    capabilities.canAssignTesters
      ? loadList<VerifiedTesterRow>('testers', {
          page: 1,
          limit: TESTER_POOL_SIZE,
          query: { status: 'VERIFIED', sort: 'ratingAverage', order: 'desc' },
        })
      : Promise.resolve({ error: 'forbidden' as const }),
    loadList<ProjectBugRow>('bugs', {
      page: 1,
      limit: BUG_PREVIEW_SIZE,
      query: { projectId: project.id },
    }),
    serverFetchOrNull<readonly { id: string; name: string; createdAt: string; _count: { bugs: number } }[]>(
      `projects/${project.id}/features`,
    ),
  ])

  const assignedTesterIds = new Set(project.assignments.map((row) => row.tester.id))
  // `assertAssignable` on the API rejects a tester who is not ACTIVE or has not
  // accepted the NDA, so those are filtered out here rather than offered and
  // then refused. Already-assigned testers are dropped for the same reason.
  const invitable =
    'items' in testerPool
      ? testerPool.items.filter(
          (tester) =>
            tester.user.status === 'ACTIVE' &&
            tester.ndaAcceptedAt !== null &&
            !assignedTesterIds.has(tester.user.id),
        )
      : []

  const transitions = allowedTransitions(project.status)
  const priority = isProjectPriority(project.priority) ? project.priority : 'NORMAL'

  const overview: DescriptionItem[] = [
    { label: 'Reference', value: <Mono>{project.reference}</Mono> },
    {
      label: 'Organisation',
      value: (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
          }}
        >
          <Link
            href={`/app/admin/organisations/${project.organisation.id}`}
            style={{
              color: 'var(--text-brand)',
              textDecoration: 'underline',
              textUnderlineOffset: 3,
            }}
          >
            {project.organisation.name}
          </Link>
          <StatusBadge status={project.organisation.status} />
        </span>
      ),
    },
    { label: 'Raised by', value: personName(project.createdBy) },
    { label: 'Priority', value: titleCase(project.priority) },
    { label: 'Created', value: formatDate(project.createdAt) },
    { label: 'Last updated', value: formatDate(project.updatedAt) },
    { label: 'Submitted', value: formatDate(project.submittedAt) },
    { label: 'Approved', value: formatDate(project.approvedAt) },
    { label: 'Completed', value: formatDate(project.completedAt) },
    { label: 'Window', value: `${formatDate(project.startDate)} to ${formatDate(project.endDate)}` },
    { label: 'Platform targets', value: <TokenList values={project.platformTargets} /> },
    { label: 'Target countries', value: <TokenList values={project.targetCountries} /> },
    {
      label: 'Target languages',
      value: <TokenList values={project.targetLanguages} uppercase={false} />,
    },
    {
      label: 'Summary',
      wide: true,
      value: project.summary ? <Prose>{project.summary}</Prose> : '',
    },
    {
      label: 'Testing instructions',
      wide: true,
      value: project.instructions ? <Prose>{project.instructions}</Prose> : '',
    },
  ]

  const assignmentColumns: readonly TableColumn<ProjectAssignmentRow>[] = [
    {
      key: 'tester',
      header: 'Tester',
      render: (row) => personName(row.tester),
      renderSecondary: (row) => row.tester.email,
    },
    {
      key: 'status',
      header: 'Assignment',
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'country',
      header: 'Country',
      render: (row) => row.tester.testerProfile?.countryCode ?? '—',
    },
    {
      key: 'rating',
      header: 'Rating',
      align: 'right',
      render: (row) => formatRating(row.tester.testerProfile?.ratingAverage),
    },
    { key: 'invited', header: 'Invited', align: 'right', render: (row) => formatDate(row.invitedAt) },
    {
      key: 'responded',
      header: 'Responded',
      align: 'right',
      render: (row) => formatDate(row.respondedAt),
    },
  ]

  const bugColumns: readonly TableColumn<ProjectBugRow>[] = [
    {
      key: 'title',
      header: 'Bug',
      render: (row) => row.title,
      renderSecondary: (row) => row.reference,
    },
    { key: 'severity', header: 'Severity', render: (row) => <SeverityBadge severity={row.severity} /> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'reporter', header: 'Reported by', render: (row) => personName(row.reportedBy) },
    { key: 'logged', header: 'Logged', align: 'right', render: (row) => formatDate(row.createdAt) },
  ]

  return (
    <DetailShell
      crumbs={[{ label: 'Projects', href: '/app/admin/projects' }, { label: project.reference }]}
      eyebrow="Delivery"
      title={project.title}
      badges={
        <>
          <StatusBadge status={project.status} />
          <Badge tone={priority === 'URGENT' || priority === 'HIGH' ? 'warning' : 'neutral'}>
            {priority}
          </Badge>
        </>
      }
      subtitle={
        <>
          {project.reference} · {project.organisation.name} · raised by{' '}
          {personName(project.createdBy)} on {formatDate(project.createdAt)}
        </>
      }
      aside={
        <>
          <Panel
            title="Status"
            description={`Now ${titleCase(project.status).toLowerCase()}. Only legal moves are listed.`}
          >
            {!capabilities.canChangeStatus ? (
              <Muted>
                You can read this project but not move it. That needs the project.write
                permission.
              </Muted>
            ) : transitions.length === 0 ? (
              <Muted>
                A cancelled project is closed for good. Raise a new one to run this scope again.
              </Muted>
            ) : (
              <form action={changeProjectStatus} style={stackStyle}>
                <input type="hidden" name="id" value={project.id} />
                <Field label="Move to" htmlFor="status-next">
                  <Select
                    id="status-next"
                    name="status"
                    required
                    defaultValue={transitions[0]}
                    options={transitions.map((value) => ({ value, label: titleCase(value) }))}
                  />
                </Field>
                <Field
                  label="Note"
                  htmlFor="status-note"
                  hint="Recorded on the audit trail. Not sent to the customer."
                >
                  <Textarea
                    id="status-note"
                    name="note"
                    rows={3}
                    placeholder="Why is it moving?"
                    maxLength={1000}
                  />
                </Field>
                <Button type="submit" variant="primary" fullWidth>
                  Change status
                </Button>
              </form>
            )}
          </Panel>

          <Panel
            title="Priority and progress"
            description="Progress is the figure the delivery team reports, not a computed one."
          >
            {capabilities.canUpdate ? (
              <form action={updateProjectDelivery} style={stackStyle}>
                <input type="hidden" name="id" value={project.id} />
                <Field label="Priority" htmlFor="priority">
                  <Select
                    id="priority"
                    name="priority"
                    defaultValue={priority}
                    options={PROJECT_PRIORITIES.map((value) => ({
                      value,
                      label: titleCase(value),
                    }))}
                  />
                </Field>
                <Field label="Progress" htmlFor="progress" hint="A whole percentage, 0 to 100.">
                  <Input
                    id="progress"
                    name="progressPercent"
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    defaultValue={project.progressPercent}
                  />
                </Field>
                <ProgressBar percent={project.progressPercent} />
                <Button type="submit" variant="secondary" fullWidth>
                  Save priority and progress
                </Button>
              </form>
            ) : (
              <div style={stackStyle}>
                <ProgressBar percent={project.progressPercent} />
                <Muted>Editing needs the project.write permission.</Muted>
              </div>
            )}
          </Panel>

          <Panel title="At a glance">
            <DescriptionList
              items={[
                {
                  label: 'Testers on the roster',
                  value: project.maxTesters
                    ? `${project._count.assignments} / ${project.maxTesters}`
                    : String(project._count.assignments),
                },
                { label: 'Bugs logged', value: String(project._count.bugs) },
                { label: 'Materials attached', value: String(project._count.materials) },
              ]}
            />
          </Panel>

          <Panel
            title="Managers"
            description="Internal owners. Assigned from the managers section."
          >
            {project.managers.length === 0 ? (
              <Muted>No manager oversees this project yet.</Muted>
            ) : (
              <ul style={listResetStyle}>
                {project.managers.map((row) => (
                  <li key={row.manager.id} style={rowStyle}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                      <span style={{ fontSize: 'var(--type-body-sm-size)' }}>
                        {personName(row.manager)}
                      </span>
                      <Caption>Since {formatDate(row.assignedAt)}</Caption>
                    </div>
                    <RoleBadge role={row.manager.role} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      }
    >
      <Panel title="Overview" description="What the customer asked for and where it stands.">
        <DescriptionList items={overview} />
      </Panel>

      {capabilities.canUpdate ? (
        <Panel
          title="Edit the brief"
          description="Scope, instructions and dates. Priority and progress are in the aside."
        >
          <TrackedForm action={updateProjectBrief} style={stackStyle}>
            <input type="hidden" name="id" value={project.id} />

            <Field label="Title" htmlFor="title" required>
              <Input
                id="title"
                name="title"
                required
                minLength={3}
                maxLength={200}
                defaultValue={project.title}
              />
            </Field>

            <Field label="Summary" htmlFor="summary" hint="One or two sentences on the scope.">
              <Textarea
                id="summary"
                name="summary"
                rows={3}
                maxLength={2000}
                defaultValue={project.summary ?? ''}
              />
            </Field>

            <Field
              label="Testing instructions"
              htmlFor="instructions"
              hint="What a tester needs to follow. Only visible to accepted testers."
            >
              <Textarea
                id="instructions"
                name="instructions"
                rows={10}
                maxLength={20000}
                defaultValue={project.instructions ?? ''}
              />
            </Field>

            <div style={fieldGridStyle}>
              <Field
                label="Platform targets"
                htmlFor="platformTargets"
                hint="Comma separated, for example: Android, iOS, Web."
              >
                <Input
                  id="platformTargets"
                  name="platformTargets"
                  defaultValue={project.platformTargets.join(', ')}
                />
              </Field>

              <Field
                label="Target countries"
                htmlFor="targetCountries"
                hint="Two-letter ISO codes, comma separated: IN, GB, US."
              >
                <Input
                  id="targetCountries"
                  name="targetCountries"
                  pattern="\s*[A-Za-z]{2}\s*(,\s*[A-Za-z]{2}\s*)*"
                  title="Two-letter country codes separated by commas"
                  defaultValue={project.targetCountries.join(', ')}
                />
              </Field>

              <Field
                label="Target languages"
                htmlFor="targetLanguages"
                hint="Two-letter ISO codes, comma separated: en, hi, ta."
              >
                <Input
                  id="targetLanguages"
                  name="targetLanguages"
                  pattern="\s*[A-Za-z]{2}\s*(,\s*[A-Za-z]{2}\s*)*"
                  title="Two-letter language codes separated by commas"
                  defaultValue={project.targetLanguages.join(', ')}
                />
              </Field>

              <Field label="Start date" htmlFor="startDate">
                <Input
                  id="startDate"
                  name="startDate"
                  type="date"
                  defaultValue={toDateInput(project.startDate)}
                />
              </Field>

              <Field label="End date" htmlFor="endDate" hint="Must not fall before the start date.">
                <Input
                  id="endDate"
                  name="endDate"
                  type="date"
                  defaultValue={toDateInput(project.endDate)}
                />
              </Field>

              <Field label="Maximum testers" htmlFor="maxTesters" hint="Leave blank for no cap.">
                <Input
                  id="maxTesters"
                  name="maxTesters"
                  type="number"
                  min={1}
                  max={10000}
                  defaultValue={project.maxTesters ?? ''}
                />
              </Field>
            </div>

            <Checkbox
              id="testersCanSeeOtherBugs"
              name="testersCanSeeOtherBugs"
              defaultChecked={project.testersCanSeeOtherBugs}
              label="Testers can see bugs raised by others"
              description="Off by default. When on, any tester with an accepted assignment on this project can read every bug logged against it, not just their own reports."
            />

            <div>
              <Button type="submit" variant="primary">
                Save the brief
              </Button>
            </div>
          </TrackedForm>
        </Panel>
      ) : null}

      <Panel
        title="Tester roster"
        description={`${project._count.assignments} tester${
          project._count.assignments === 1 ? '' : 's'
        } invited to this project.`}
        flush
      >
        <Table
          ariaLabel="Tester roster"
          columns={assignmentColumns}
          rows={project.assignments}
          rowKey={(row) => row.tester.id}
          style={bareTableStyle}
          emptyState={
            <div style={{ padding: 'var(--space-6)' }}>
              <Muted>
                Nobody is on this project yet. Invite verified testers below and they will be asked
                to accept.
              </Muted>
            </div>
          }
        />
      </Panel>

      {capabilities.canAssignTesters ? (
        <>
          <Panel
            title="Invite testers"
            description="Verified testers who have accepted the NDA and are not already on the roster."
          >
            {'error' in testerPool ? (
              <Muted>
                The tester pool could not be read. Inviting from here needs the tester.read
                permission as well as project.assign.
              </Muted>
            ) : invitable.length === 0 ? (
              <Muted>
                Every verified tester in the top {TESTER_POOL_SIZE} by rating is already on this
                roster. Verify more testers to widen the pool.
              </Muted>
            ) : (
              <form action={inviteTesters} style={stackStyle}>
                <input type="hidden" name="id" value={project.id} />
                <fieldset style={fieldsetStyle}>
                  <legend
                    className="c4t-eyebrow"
                    style={{ color: 'var(--text-muted)', padding: 0 }}
                  >
                    Choose testers
                  </legend>
                  <div style={checkboxGridStyle}>
                    {invitable.map((tester) => {
                      const fit = deviceFitsTargets(tester.devices, project.platformTargets)
                      return (
                        <Checkbox
                          key={tester.user.id}
                          id={`tester-${tester.user.id}`}
                          name="testerIds"
                          value={tester.user.id}
                          label={personName(tester.user)}
                          description={`${tester.user.email} · ${
                            tester.countryCode ?? 'no country'
                          } · ${formatRating(tester.ratingAverage)}${
                            fit === 'mismatch' ? ' · no device on this platform' : ''
                          }`}
                        />
                      )
                    })}
                  </div>
                </fieldset>
                <Field
                  label="Note to the testers"
                  htmlFor="invite-notes"
                  hint="Sent with the invitation. Keep it to what they need to decide."
                >
                  <Textarea
                    id="invite-notes"
                    name="notes"
                    rows={3}
                    maxLength={1000}
                    placeholder="What is the ask, and by when?"
                  />
                </Field>
                <div>
                  <Button type="submit" variant="primary" iconLeft="user-check">
                    Invite selected testers
                  </Button>
                </div>
              </form>
            )}
          </Panel>

          {project.assignments.length > 0 ? (
            <Panel
              title="Update an assignment"
              description="Activate a tester who accepted, mark their work complete, or take them off."
            >
              <form action={updateAssignment} style={stackStyle}>
                <input type="hidden" name="id" value={project.id} />
                <div style={fieldGridStyle}>
                  <Field label="Tester" htmlFor="assignment-tester" required>
                    <Select
                      id="assignment-tester"
                      name="testerId"
                      required
                      options={project.assignments.map((row) => ({
                        value: row.tester.id,
                        label: `${personName(row.tester)} · ${titleCase(row.status)}`,
                      }))}
                    />
                  </Field>
                  <Field label="New assignment status" htmlFor="assignment-status" required>
                    <Select
                      id="assignment-status"
                      name="status"
                      required
                      options={ASSIGNMENT_STATUSES.map((value) => ({
                        value,
                        label: titleCase(value),
                      }))}
                      defaultValue="ACTIVE"
                    />
                  </Field>
                </div>
                <Field
                  label="Note"
                  htmlFor="assignment-notes"
                  hint="Replaces the note on that assignment. Leave blank to keep the current one."
                >
                  <Textarea id="assignment-notes" name="notes" rows={3} maxLength={1000} />
                </Field>
                <div>
                  <Button type="submit" variant="secondary">
                    Update assignment
                  </Button>
                </div>
              </form>
            </Panel>
          ) : null}
        </>
      ) : (
        <Panel title="Invite testers">
          <Muted>
            Staffing this project needs the project.assign permission. Ask an administrator to
            grant it.
          </Muted>
        </Panel>
      )}

      <Panel
        title="Materials"
        description="Builds, credentials and reference documents an accepted tester can open."
      >
        {!capabilities.canReadBrief ? (
          <Muted>The brief and its materials are not visible to you on this project.</Muted>
        ) : project.materials.length === 0 ? (
          <Muted>No material is attached yet.</Muted>
        ) : (
          <ul style={listResetStyle}>
            {project.materials.map((material) => (
              <li key={material.id} style={rowStyle}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                  <span style={{ fontSize: 'var(--type-body-sm-size)' }}>{material.title}</span>
                  {material.description ? <Caption>{material.description}</Caption> : null}
                  <MaterialTarget material={material} />
                  <Caption>Added {formatDate(material.createdAt)}</Caption>
                </div>
                {capabilities.canManageMaterials ? (
                  <form action={removeMaterial}>
                    <input type="hidden" name="id" value={project.id} />
                    <input type="hidden" name="materialId" value={material.id} />
                    <Button type="submit" variant="ghost" size="sm" iconLeft="x">
                      Remove
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {capabilities.canManageMaterials ? (
        <Panel
          title="Attach a material"
          description="Give it a title and either a link or the id of a file already uploaded."
        >
          <form action={addMaterial} style={stackStyle}>
            <input type="hidden" name="id" value={project.id} />
            <div style={fieldGridStyle}>
              <Field label="Title" htmlFor="material-title" required>
                <Input
                  id="material-title"
                  name="title"
                  required
                  maxLength={200}
                  placeholder="Android build 4.2.1"
                />
              </Field>
              <Field label="Link" htmlFor="material-url" hint="A full https:// URL.">
                <Input
                  id="material-url"
                  name="url"
                  type="url"
                  maxLength={2000}
                  placeholder="https://builds.example.com/4.2.1.apk"
                />
              </Field>
              <Field
                label="Uploaded file id"
                htmlFor="material-file"
                hint="Use instead of a link when the file came through the uploads endpoint."
              >
                <Input id="material-file" name="fileId" placeholder="cl…" />
              </Field>
            </div>
            <Field
              label="Description"
              htmlFor="material-description"
              hint="What it is and what to do with it."
            >
              <Textarea id="material-description" name="description" rows={3} maxLength={2000} />
            </Field>
            <div>
              <Button type="submit" variant="secondary" iconLeft="plus">
                Attach material
              </Button>
            </div>
          </form>
        </Panel>
      ) : null}

      <Panel
        title="Features"
        description="The tags a bug can be filed against. Delete one and any bug already carrying it just loses the tag — the report stays."
      >
        {!features ? (
          <Muted>Features could not be read.</Muted>
        ) : features.length === 0 ? (
          <Muted>No features listed yet.</Muted>
        ) : (
          <ul style={listResetStyle}>
            {features.map((feature) => (
              <li key={feature.id} style={rowStyle}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                  <span style={{ fontSize: 'var(--type-body-sm-size)' }}>{feature.name}</span>
                  <Caption>
                    {feature._count.bugs} bug{feature._count.bugs === 1 ? '' : 's'}
                  </Caption>
                </div>
                {capabilities.canManageMaterials ? (
                  <form action={removeFeature}>
                    <input type="hidden" name="id" value={project.id} />
                    <input type="hidden" name="featureId" value={feature.id} />
                    <Button type="submit" variant="ghost" size="sm" iconLeft="x">
                      Remove
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {capabilities.canManageMaterials ? (
          <form
            action={addFeature}
            style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-5)' }}
          >
            <input type="hidden" name="id" value={project.id} />
            <Input name="name" required maxLength={120} placeholder="Checkout" />
            <Button type="submit" variant="secondary" iconLeft="plus">
              Add feature
            </Button>
          </form>
        ) : null}
      </Panel>

      <Panel
        title="Bugs"
        description={
          project._count.bugs > BUG_PREVIEW_SIZE
            ? `The ${BUG_PREVIEW_SIZE} most recent of ${project._count.bugs} reports on this project.`
            : `${project._count.bugs} report${project._count.bugs === 1 ? '' : 's'} on this project.`
        }
        flush
      >
        {'error' in bugs ? (
          <div style={{ padding: 'var(--space-6)' }}>
            <Muted>
              {bugs.error === 'forbidden'
                ? 'Reading defects needs the bug.read permission.'
                : 'The bugs service is unreachable. Refresh in a moment.'}
            </Muted>
          </div>
        ) : (
          <Table
            ariaLabel="Bugs on this project"
            columns={bugColumns}
            rows={bugs.items}
            rowKey={(row) => row.id}
            rowHref={(row) => `/app/admin/bugs/${row.id}`}
            style={bareTableStyle}
            emptyState={
              <div style={{ padding: 'var(--space-6)' }}>
                <Muted>No defect has been logged against this project yet.</Muted>
              </div>
            }
          />
        )}
      </Panel>

      {canDelete ? (
        <Panel
          title="Archive this project"
          description="The project is soft-deleted and its status set to cancelled. Bugs, materials and the roster are kept."
        >
          <form action={archiveProject} style={stackStyle}>
            <input type="hidden" name="id" value={project.id} />
            <input type="hidden" name="reference" value={project.reference} />
            <Field
              label={`Type ${project.reference} to confirm`}
              htmlFor="confirm"
              hint="Nothing happens unless the reference matches."
            >
              <Input id="confirm" name="confirm" required autoComplete="off" />
            </Field>
            <div>
              <Button type="submit" variant="secondary" iconLeft="alert-triangle">
                Archive project
              </Button>
            </div>
          </form>
        </Panel>
      ) : null}
    </DetailShell>
  )
}

// ─── Local presentation helpers ──────────────────────────────────────────────
// These are page-local on purpose: none of them is general enough to earn a
// place in components/admin, and the shared shells already own the layout.

const stackStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 'var(--space-5)',
}

const fieldGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 'var(--space-5)',
}

const checkboxGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
  gap: 'var(--space-4)',
}

const fieldsetStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 'var(--space-4)',
  margin: 0,
  padding: 0,
  border: 'none',
}

const listResetStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column' as const,
}

const rowStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 'var(--space-5)',
  paddingBlock: 'var(--space-4)',
  borderBottom: '1px solid var(--border-subtle)',
}

/**
 * The table already draws a border and a radius, which reads as a card inside a
 * card when it sits in a flush panel. Stripping them lets the panel own the
 * frame while the table keeps its sunken header row.
 */
const bareTableStyle = {
  border: 'none',
  borderRadius: 0,
  background: 'transparent',
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <p
      className="c4t-body-sm"
      style={{ margin: 0, color: 'var(--text-secondary)', maxWidth: '75ch' }}
    >
      {children}
    </p>
  )
}

function Caption({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 'var(--type-caption-size)', color: 'var(--text-muted)' }}>
      {children}
    </span>
  )
}

function Mono({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: 'var(--font-mono)' }}>{children}</span>
}

/** Long free text from the customer. Their line breaks are meaningful. */
function Prose({ children }: { children: ReactNode }) {
  return (
    <span style={{ display: 'block', whiteSpace: 'pre-wrap', maxWidth: '75ch' }}>{children}</span>
  )
}

/** Renders a string array as pills, or an em dash when it is empty. */
function TokenList({ values, uppercase = true }: { values: string[]; uppercase?: boolean }) {
  if (values.length === 0) return <span style={{ color: 'var(--text-muted)' }}>—</span>
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      {values.map((value) => (
        <Badge key={value} tone="neutral" uppercase={uppercase}>
          {value}
        </Badge>
      ))}
    </span>
  )
}

function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <span
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
      role="img"
      aria-label={`${clamped}% complete`}
    >
      <span
        aria-hidden="true"
        style={{
          flex: 1,
          height: 'var(--space-3)',
          borderRadius: 'var(--radius-full)',
          background: 'var(--surface-sunken)',
          border: '1px solid var(--border-subtle)',
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            display: 'block',
            height: '100%',
            width: `${clamped}%`,
            background: 'var(--accent-base)',
          }}
        />
      </span>
      <span
        style={{
          fontVariantNumeric: 'tabular-nums',
          fontSize: 'var(--type-body-sm-size)',
          color: 'var(--text-secondary)',
        }}
      >
        {clamped}%
      </span>
    </span>
  )
}

/** A material points at either an uploaded file or an external link, never both. */
function MaterialTarget({ material }: { material: ProjectMaterial }) {
  if (material.file) {
    return (
      <Caption>
        {material.file.originalName} · {material.file.mimeType} ·{' '}
        {formatBytes(material.file.sizeBytes)}
      </Caption>
    )
  }
  if (material.url) {
    return (
      <a
        href={material.url}
        rel="noreferrer noopener"
        target="_blank"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          color: 'var(--text-brand)',
          fontSize: 'var(--type-body-sm-size)',
          textDecoration: 'underline',
          textUnderlineOffset: 3,
          wordBreak: 'break-all',
        }}
      >
        <Icon name="share-2" size={16} />
        {material.url}
      </a>
    )
  }
  return <Caption>No link or file recorded.</Caption>
}

/** `2026-08-14T12:09:18.713Z` → `2026-08-14`, which is what a date input wants. */
function toDateInput(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}

/**
 * `ratingAverage` is a Prisma Decimal, which serialises to a JSON string — so
 * `toFixed` on the raw value would throw. Coerced first, every time.
 */
function formatRating(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  const score = Number(value)
  return Number.isFinite(score) ? `${score.toFixed(1)} / 5` : '—'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'kB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}
