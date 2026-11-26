import sys
src, new, name = sys.argv[1:4]
out = sys.argv[4] if len(sys.argv) > 4 else None
L = open(src).read().split('\n')
# find trailing "mod tests {" with cfg(test) above
idx = max(i for i,l in enumerate(L) if l == 'mod tests {')
assert L[idx-1] == '#[cfg(test)]'
assert L[-1] == '' and L[-2] == '}'
body = L[idx+1:-2]
head = L[:idx-1]
open(out or src,'w').write('\n'.join(head + ['#[cfg(test)]', '#[path = "%s"]' % name, 'mod tests;', '']))
open(new,'w').write('\n'.join(body) + '\n')
