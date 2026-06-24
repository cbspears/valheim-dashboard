// Connectivity test: connect to the real FTP, report the log file size, show
// the last few lines, and which presence patterns currently match. Read-only.
import 'dotenv/config';
import { Client as FtpClient } from 'basic-ftp';
import { Writable } from 'node:stream';
import { RE } from './src/parser.js';

const host = process.env.FTP_HOST;
const port = parseInt(process.env.FTP_PORT || '21', 10);
const logPath = process.env.LOG_PATH || 'BepInEx/LogOutput.log';

const client = new FtpClient(15000);
try {
  await client.access({
    host,
    port,
    user: process.env.FTP_USER,
    password: process.env.FTP_PASSWORD,
    secure: false,
  });
  console.log(`✓ connected to ${host}:${port}`);
  const size = await client.size(logPath);
  console.log(`✓ ${logPath} is ${size} bytes`);

  // Pull the last ~6KB to sample recent activity.
  const start = Math.max(0, size - 6000);
  const chunks = [];
  const sink = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } });
  await client.downloadTo(sink, logPath, start);
  const tail = Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean);

  console.log(`\n--- last ${Math.min(tail.length, 8)} lines ---`);
  for (const line of tail.slice(-8)) console.log('  ' + line);

  console.log('\n--- pattern matches in tail ---');
  const counts = {};
  for (const line of tail) {
    for (const [name, re] of Object.entries(RE)) {
      if (re.test(line)) counts[name] = (counts[name] || 0) + 1;
    }
  }
  console.log('  ' + (Object.keys(counts).length ? JSON.stringify(counts) : 'none (idle server window)'));
} catch (err) {
  console.error('✗ FTP test failed:', err.message);
  process.exitCode = 1;
} finally {
  client.close();
}
