import re

f = 'src/app/app/admin/testers/page.tsx'
s = open(f, encoding='utf-8').read()

# Add avatarFileId to TesterRow.user
s = s.replace(
    "  user: {\n    id: string\n    email: string\n    firstName: string | null\n    lastName: string | null\n    status: string\n  }",
    "  user: {\n    id: string\n    email: string\n    firstName: string | null\n    lastName: string | null\n    status: string\n    avatarFileId: string | null\n  }",
)

# Add Avatar import after StatusBadge
s = s.replace(
    "import { StatusBadge } from '@/components/admin/StatusBadge'",
    "import { Avatar } from '@/components/admin/Avatar'\nimport { StatusBadge } from '@/components/admin/StatusBadge'",
)

# Replace the "Tester" column render to include the avatar
old = '''    {
      key: 'name',
      header: 'Tester',
      render: (row) => personName(row.user),
      renderSecondary: (row) => row.user.email,
    },'''
new = '''    {
      key: 'name',
      header: 'Tester',
      render: (row) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <Avatar name={personName(row.user)} fileId={row.user.avatarFileId} size="sm" />
          {personName(row.user)}
        </span>
      ),
      renderSecondary: (row) => row.user.email,
    },'''
if old not in s:
    print('OLD not found')
    raise SystemExit(1)
s = s.replace(old, new)

open(f, 'w', encoding='utf-8').write(s)
print('done')
