import pathlib
p = pathlib.Path('src/modules/auth/auth.service.ts')
s = p.read_text(encoding='utf-8')
old = (
    "import { sendMail, verificationEmail, passwordResetEmail } from '../../lib/mailer.js'\n"
    "import { logger } from '../../lib/logger.js'\n"
    "import type { RegisterInput, LoginInput } from './auth.schema.js'"
)
new = (
    "import { sendMail, verificationEmail, passwordResetEmail } from '../../lib/mailer.js'\n"
    "import { logger } from '../../lib/logger.js'\n"
    "import { isBlockedTesterEmail } from '../../config/env.js'\n"
    "import type { RegisterInput, LoginInput } from './auth.schema.js'"
)
assert old in s, 'not found'
p.write_text(s.replace(old, new), encoding='utf-8')
print('done')
