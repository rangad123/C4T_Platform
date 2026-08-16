import pathlib
p = pathlib.Path('src/modules/auth/auth.service.ts')
s = p.read_text(encoding='utf-8')
old = (
    "  const existing = await prisma.user.findUnique({\n"
    "    where: { email: input.email },\n"
    "    select: { id: true },\n"
    "  })\n"
    "  if (existing) {\n"
    "    // Registration is not an account-enumeration oracle we can fully close\n"
    "    // (the UX requires telling people their email is taken), but we say no more\n"
    "    // than that.\n"
    "    throw new ConflictError('An account with this email already exists')\n"
    "  }\n"
    "\n"
    "  const passwordHash = await hashPassword(input.password)"
)
new = (
    "  const existing = await prisma.user.findUnique({\n"
    "    where: { email: input.email },\n"
    "    select: { id: true },\n"
    "  })\n"
    "  if (existing) {\n"
    "    // Registration is not an account-enumeration oracle we can fully close\n"
    "    // (the UX requires telling people their email is taken), but we say no more\n"
    "    // than that.\n"
    "    throw new ConflictError('An account with this email already exists')\n"
    "  }\n"
    "\n"
    "  // Work-email enforcement for testers (Sec 2.2). Customers can sign up with\n"
    "  // a personal address. The blocklist is seeded with the obvious consumer\n"
    "  // mailbox providers in env.ts.\n"
    "  if (input.intendedRole === Role.TESTER && isBlockedTesterEmail(input.email)) {\n"
    "    throw new BadRequestError(\n"
    "      'Tester accounts need a work email address. Personal mailbox providers are not accepted.',\n"
    "    )\n"
    "  }\n"
    "\n"
    "  const passwordHash = await hashPassword(input.password)"
)
assert old in s, 'not found'
p.write_text(s.replace(old, new), encoding='utf-8')
print('done')
