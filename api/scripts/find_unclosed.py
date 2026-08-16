import re

b = open('src/modules/auth/auth.service.ts', encoding='utf-8').read()
b = re.sub(r'//[^\n]*', '', b)
b = re.sub(r'/\*[\s\S]*?\*/', '', b)
b = re.sub(r"'(?:\\.|[^'\\])*'", "''", b)
b = re.sub(r'"(?:\\.|[^"\\])*"', '""', b)
b = re.sub(r'`(?:\\.|[^\\])*`', '``', b)

depth = 0
line = 1
col = 0
for ch in b:
    if ch == '\n':
        line += 1; col = 0
    else:
        col += 1
    if ch == '{':
        depth += 1
        if depth == 1:
            # Remember this opening brace's location, in case depth never returns to 0.
            open_line, open_col = line, col
    elif ch == '}':
        depth -= 1
        if depth == 0 and 'open_line' in dir():
            del open_line, open_col  # closed

print('final depth:', depth)
if depth != 0 and 'open_line' in dir():
    print(f'last unclosed open at line {open_line} col {open_col}')
