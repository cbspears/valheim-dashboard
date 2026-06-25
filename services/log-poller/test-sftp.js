// Connectivity test: connect to the real SFTP, report the log file size, show
// the last few lines, and which presence patterns currently match. Read-only.
import 'dotenv/config';
import SftpClient from 'ssh2-sftp-client';
import { RE } from './src/parser.js';

const host = process.env.SFTP_HOST;
const port = parseInt(process.env.SFTP_PORT || '8822', 10);
const logPath = process.env.LOG_PATH || 'BepInEx/LogOutput.log';

const sftp = new SftpClient();
try {
  await sftp.connect({
    host,
    port,
    username: process.env.SFTP_USER,
    password: process.env.SFTP_PASSWORD,
    readyTimeout: 15000,
  });
  console.log(`✓ connected to ${host}:${port}`);
  const { size } = await sftp.stat(logPath);
  console.log(`✓ ${logPath} is ${size} bytes`);

  // Pull the last ~6KB to sample recent activity.
  const start = Math.max(0, size - 6000);
  const buf = await sftp.get(logPath, undefined, {
    readStreamOptions: { start, end: size - 1 },
  });
  const tail = buf.toString('utf8').split('\n').filter(Boolean);

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
  console.error('✗ SFTP test failed:', err.message);
  process.exitCode = 1;
} finally {
  await sftp.end();
}
