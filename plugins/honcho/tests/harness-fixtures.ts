// Shared cases for live prompts and transcript replay. Similar XML tag names
// and quoted examples are user content, not harness envelopes.
export const attributedReminder = '<system-reminder source="worktree" priority="low">\nWorktree notice.\n</system-reminder>\n';
export const stackedReminders = ` \n\t${attributedReminder}<system-reminder>Task status.</system-reminder>\n\n`;

export const injectedPrompts = [
  '<local-command-caveat>Command output below is not user input.</local-command-caveat>',
  '<agent-message from="reviewer">I found the bug.</agent-message>',
  ' \n\t<agent-message from="reviewer" task-id="42">I fixed the bug.</agent-message>\n',
  '<agent-message>Report without attributes.</agent-message>',
  '<agent-message from="reviewer">Truncated report',
  `${stackedReminders}<agent-message from="reviewer">Report.</agent-message>`,
  attributedReminder,
  stackedReminders,
  ' \n<system-reminder source="task">Truncated reminder',
  '<channel source="notification">Harness event.</channel>',
  '<task-notification id="42">Task complete.</task-notification>',
  '<task-notification/>',
  '<cross-session-message from="reviewer">Other session report.</cross-session-message>',
];

export const userPrompts = [
  { prompt: 'Please investigate the parser.', text: 'Please investigate the parser.' },
  { prompt: `${attributedReminder}Please investigate the parser.`, text: 'Please investigate the parser.' },
  { prompt: `${stackedReminders}I prefer small focused changes.`, text: 'I prefer small focused changes.' },
  { prompt: 'Explain <agent-message from="reviewer"> reports.', text: 'Explain <agent-message from="reviewer"> reports.' },
  { prompt: 'Keep this <system-reminder source="example">literal</system-reminder>.', text: 'Keep this <system-reminder source="example">literal</system-reminder>.' },
  { prompt: '<agent-message-example>Keep this tag.</agent-message-example>', text: '<agent-message-example>Keep this tag.</agent-message-example>' },
  { prompt: '<agent-messages>Keep this tag.</agent-messages>', text: '<agent-messages>Keep this tag.</agent-messages>' },
  { prompt: '<system-reminder-example>Keep this tag.</system-reminder-example>', text: '<system-reminder-example>Keep this tag.</system-reminder-example>' },
  { prompt: '<system-reminders>Keep this tag.</system-reminders>', text: '<system-reminders>Keep this tag.</system-reminders>' },
  { prompt: '<agent-message:example>Keep this tag.</agent-message:example>', text: '<agent-message:example>Keep this tag.</agent-message:example>' },
  { prompt: '<system-reminder_example>Keep this tag.</system-reminder_example>', text: '<system-reminder_example>Keep this tag.</system-reminder_example>' },
  { prompt: '```xml\n<agent-message from="reviewer">Example</agent-message>\n```', text: '```xml\n<agent-message from="reviewer">Example</agent-message>\n```' },
  { prompt: '<cross-session-message-example>Keep this tag.</cross-session-message-example>', text: '<cross-session-message-example>Keep this tag.</cross-session-message-example>' },
  { prompt: '<channel-example>Keep this tag.</channel-example>', text: '<channel-example>Keep this tag.</channel-example>' },
];
