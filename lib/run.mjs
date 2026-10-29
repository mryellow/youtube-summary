import { spawn } from 'node:child_process';

// Spawn a command and resolve with its output. Rejects on spawn failure or non-zero exit.
// opts.input is written to stdin; opts.onLine is called for each complete stdout line;
// opts.showStderr passes stderr through to the terminal (for slow tools with their own progress output).
export function run(cmd, args, { input, onLine, cwd, showStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', showStderr ? 'inherit' : 'pipe'] });
    let stdout = '';
    let stderr = '';
    let partial = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      if (!onLine) return;
      partial += d;
      const lines = partial.split('\n');
      partial = lines.pop();
      lines.forEach(onLine);
    });
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (onLine && partial) onLine(partial);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with ${code}\n${stderr.slice(-2000)}`.trim()));
    });
    child.stdin.end(input ?? '');
  });
}
