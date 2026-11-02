/* Stand up a FAKE guacd that speaks the real handshake, and check our client
   drives it correctly — especially that "connect" values are positioned to match
   the arg names guacd asked for, in guacd's order, not ours. */
const net = require('net');
const g = require('../engine/guacd.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n         got  ' + a + '\n         want ' + b); }
}

function fakeGuacd({ argNames, withVersion, failWith }) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = net.createServer(sock => {
      const parser = new g.Parser();
      sock.on('data', chunk => {
        for (const inst of parser.push(chunk.toString('utf8'))) {
          seen.push(inst);
          if (inst[0] === 'select') {
            if (failWith) { sock.write(g.encode('error', failWith, '769')); return; }
            const names = withVersion ? ['VERSION_1_5_0', ...argNames] : argNames;
            sock.write(g.encode('args', ...names));
          } else if (inst[0] === 'connect') {
            sock.write(g.encode('ready', '$fake-connection'));
          }
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
  });
}

(async () => {
  console.log('-- handshake: values must line up with guacd\'s arg ORDER --');
  {
    // deliberately NOT the order a person would guess
    const argNames = ['port', 'password', 'hostname', 'username', 'ignore-cert'];
    const { srv, port, seen } = await fakeGuacd({ argNames, withVersion: true });
    const conn = await g.open({
      protocol: 'rdp', host: '127.0.0.1', port, width: 1280, height: 800,
      params: { hostname: '192.168.211.5', port: 3389, username: 'sandbox', password: 'pw', 'ignore-cert': 'true' },
    });
    eq('resolved with connection id', conn.connectionId, '$fake-connection');

    const select = seen.find(i => i[0] === 'select');
    eq('select carries the protocol', select, ['select', 'rdp']);

    const size = seen.find(i => i[0] === 'size');
    eq('size forwarded', size, ['size', '1280', '800', '96']);

    const connect = seen.find(i => i[0] === 'connect');
    // version echoed first, then one value per requested arg IN GUACD'S ORDER
    eq('connect echoes version then positional values', connect,
      ['connect', 'VERSION_1_5_0', '3389', 'pw', '192.168.211.5', 'sandbox', 'true']);

    conn.socket.destroy(); srv.close();
  }

  console.log('-- handshake: no VERSION token (older guacd) --');
  {
    const argNames = ['hostname', 'port'];
    const { srv, port, seen } = await fakeGuacd({ argNames, withVersion: false });
    const conn = await g.open({ protocol: 'rdp', host: '127.0.0.1', port, params: { hostname: 'h', port: 3389 } });
    const connect = seen.find(i => i[0] === 'connect');
    eq('connect omits version when guacd sent none', connect, ['connect', 'h', '3389']);
    conn.socket.destroy(); srv.close();
  }

  console.log('-- handshake: unknown param is sent as empty, not skipped --');
  {
    const argNames = ['hostname', 'domain', 'port'];
    const { srv, port, seen } = await fakeGuacd({ argNames, withVersion: false });
    const conn = await g.open({ protocol: 'rdp', host: '127.0.0.1', port, params: { hostname: 'h', port: 3389 } });
    const connect = seen.find(i => i[0] === 'connect');
    eq('missing "domain" becomes empty, keeping positions', connect, ['connect', 'h', '', '3389']);
    conn.socket.destroy(); srv.close();
  }

  console.log('-- handshake: guacd reports an error --');
  {
    const { srv, port } = await fakeGuacd({ argNames: [], failWith: 'Connection refused by remote' });
    let msg = null;
    try { await g.open({ protocol: 'rdp', host: '127.0.0.1', port, params: {} }); }
    catch (e) { msg = e.message; }
    eq('error instruction rejects', /Connection refused by remote/.test(msg || ''), true);
    srv.close();
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
