import re

f = 'src/app/app/admin/organisations/[id]/page.tsx'
s = open(f, encoding='utf-8').read()

s = s.replace(
    "import { hasPermission, requireRole } from '@/lib/auth/session'",
    "import { hasPermission, requireRole } from '@/lib/auth/session'\nimport { Avatar } from '@/components/admin/Avatar'"
)

pattern = re.compile(
    r"      subtitle=\{\n        <>\n          \{organisation\.slug\}\n          \{organisation\.contactEmail \? ` \xb7 \$\{organisation\.contactEmail\}` : ''\}\n        </>\n      \}",
    re.UNICODE,
)
new = (
    "      subtitle={\n"
    "        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>\n"
    '          <Avatar name={organisation.name} fileId={organisation.logoFileId} size="md" />\n'
    "          <span>\n"
    "            {organisation.slug}\n"
    "            {organisation.contactEmail ? ` \xb7 ${organisation.contactEmail}` : ''}\n"
    "          </span>\n"
    "        </span>\n"
    "      }"
)
new_s, n = pattern.subn(new, s)
if n != 1:
    print('substitutions:', n)
    raise SystemExit(1)
open(f, 'w', encoding='utf-8').write(new_s)
print('done')
