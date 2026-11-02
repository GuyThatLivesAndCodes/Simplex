const g = require('../engine/guacd.js');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n         got  ' + a + '\n         want ' + b); }
}

console.log('-- encode --');
eq('simple', g.encode('select', 'rdp'), '6.select,3.rdp;');
eq('numbers coerced', g.encode('size', 1024, 768, 96), '4.size,4.1024,3.768,2.96;');
eq('empty arg', g.encode('connect', '', 'x'), '7.connect,0.,1.x;');
eq('null -> empty', g.encode('a', null), '1.a,0.;');
// length is UTF-16 code units, not bytes: "é" is 1 unit but 2 bytes in UTF-8
eq('non-ascii uses code units', g.encode('key', 'é'), '3.key,1.é;');

console.log('-- parser --');
let p = new g.Parser();
eq('single instruction', p.push('6.select,3.rdp;'), [['select', 'rdp']]);

p = new g.Parser();
eq('two in one chunk', p.push('4.args,1.a,1.b;5.ready,2.id;'), [['args', 'a', 'b'], ['ready', 'id']]);

// split across TCP segments — the case that breaks naive parsers
p = new g.Parser();
eq('split mid-value  (part 1)', p.push('6.sel'), []);
eq('split mid-value  (part 2)', p.push('ect,3.rd'), []);
eq('split mid-value  (part 3)', p.push('p;'), [['select', 'rdp']]);

// a VALUE containing the delimiters must survive, because parsing is length-driven
p = new g.Parser();
eq('value with , and ;', p.push('4.test,5.a,b;c;'), [['test', 'a,b;c']]);

p = new g.Parser();
eq('non-ascii value', p.push('4.name,3.héy;'), [['name', 'héy']]);

p = new g.Parser();
eq('empty value', p.push('4.args,0.,1.x;'), [['args', '', 'x']]);

// round trip
p = new g.Parser();
eq('round trip', p.push(g.encode('mouse', 100, 200, 1)), [['mouse', '100', '200', '1']]);

console.log('-- probe --');
// Do NOT assume guacd is absent: it may legitimately be installed and running.
// Probe a port nothing could be on, which tests the same code path either way.
g.probe({ port: 4, timeout: 1500 }).then(ok => {
  eq('probe returns false for a dead port', ok, false);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
