import re

p = open('src/modules/auth/auth.service.ts', encoding='utf-8').read()
# Strip line + block comments and strings/comments.
b = re.sub(r'//[^\n]*', '', p)
b = re.sub(r'/\*[\s\S]*?\*/', '', b)
b = re.sub(r"'(?:\\.|[^'\\])*'", "''", b)
b = re.sub(r'"(?:\\.|[^"\\])*"', '""', b)
b = re.sub(r'`(?:\\.|[^\\])*`', '``', b)

o = b.count('{')
c = b.count('}')
print('open:', o, 'close:', c, 'diff:', o - c)
