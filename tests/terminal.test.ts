import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalReporter } from '../src/terminal.js';

test('terminal progress is concise and informative', () => {
  let output = '';
  const terminal = new TerminalReporter(text => { output += text; });

  terminal.started('run-1', 'essay', 'provider/model', 'provider default');
  terminal.sandboxReady('iad1');
  terminal.event('agent.reasoning', {
    text: `I should inspect the files first. ${'More detail. '.repeat(30)}`,
  });
  terminal.event('agent.tool-call', {
    part: {
      type: 'tool-call',
      toolName: 'run_command',
      input: { command: 'cat essay.md | wc -w' },
    },
  });
  terminal.event('agent.tool-result', {
    part: {
      type: 'tool-result',
      toolName: 'run_command',
      output: { exitCode: 0, durationMs: 42, stdout: '350\n' },
    },
  });
  terminal.phase('Downloading artifacts…');
  terminal.artifactsDownloaded(1);

  const lines = output.trim().split('\n');
  assert.equal(lines.length, 10);
  assert.match(output, /· Reasoning: provider default/);
  assert.match(output, /· Thinking: I should inspect the files first\./);
  assert.match(output, /→ run_command: cat essay\.md \| wc -w/);
  assert.match(output, /✓ run_command \(exit 0, 42ms\)/);
  assert.match(output, /✓ Downloaded 1 artifact/);
  assert.doesNotMatch(output, /350/);
  assert.ok(lines.every(line => line.length <= 175));
});

test('terminal hides file contents and shows useful failures', () => {
  let output = '';
  const terminal = new TerminalReporter(text => { output += text; });

  terminal.event('agent.tool-call', {
    part: {
      type: 'tool-call',
      toolName: 'write_files',
      input: { files: [{ path: 'report.md', content: 'private large content' }] },
    },
  });
  terminal.event('agent.tool-error', {
    part: {
      type: 'tool-error',
      toolName: 'run_command',
      error: { json: { error: { message: 'command not found' } } },
    },
  });

  assert.match(output, /→ write_files: report\.md/);
  assert.doesNotMatch(output, /private large content/);
  assert.match(output, /✗ run_command: command not found/);
});
