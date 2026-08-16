import pathlib
p = pathlib.Path('src/modules/auth/auth.service.ts')
s = p.read_text(encoding='utf-8')
old = (
    "export async function signInWithGoogle(\n"
    "  identity: GoogleIdentity,\n"
    "  signUpRole: GoogleSignUpRole,\n"
    "  context: { userAgent?: string; ipAddress?: string },\n"
    "): Promise<GoogleSignInResult> {\n"
    "  // \u2500\u2500 1. Known identity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n"
    "  const link = await prisma.oAuthAccount.findUnique({\n"
)
new = (
    "export async function signInWithGoogle(\n"
    "  identity: GoogleIdentity,\n"
    "  signUpRole: GoogleSignUpRole,\n"
    "  context: { userAgent?: string; ipAddress?: string },\n"
    "): Promise<GoogleSignInResult> {\n"
    "  // Work-email rule: testers must NOT register with a personal mailbox.\n"
    "  // Customers are exempt. Run BEFORE any DB write so the rejected email\n"
    "  // does not get half an account.\n"
    "  if (signUpRole === Role.TESTER && isBlockedTesterEmail(identity.email)) {\n"
    "    throw new BadRequestError(\n"
    "      'Tester accounts need a work email address. Personal mailbox providers are not accepted.',\n"
    "    )\n"
    "  }\n"
    "\n"
    "  // \u2500\u2500 1. Known identity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n"
    "  const link = await prisma.oAuthAccount.findUnique({\n"
)
assert old in s, 'not found'
p.write_text(s.replace(old, new), encoding='utf-8')
print('done')
