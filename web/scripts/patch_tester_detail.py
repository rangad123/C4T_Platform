import re

f = 'src/app/app/admin/testers/[id]/page.tsx'
s = open(f, encoding='utf-8').read()

# Add Avatar import after StatusBadge
s = s.replace(
    "import { StatusBadge } from '@/components/admin/StatusBadge'",
    "import { Avatar } from '@/components/admin/Avatar'\nimport { StatusBadge } from '@/components/admin/StatusBadge'",
)

old = '''      subtitle={
        <>
          {tester.user.email} · Applied {formatDate(tester.createdAt)}
        </>
      }'''
new = '''      subtitle={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <Avatar name={personName(tester.user)} fileId={tester.user.avatarFileId} size="md" />
          <span>
            {tester.user.email} · Applied {formatDate(tester.createdAt)}
          </span>
        </span>
      }'''
if old not in s:
    print('OLD not found')
    raise SystemExit(1)
s = s.replace(old, new)

open(f, 'w', encoding='utf-8').write(s)
print('done')
