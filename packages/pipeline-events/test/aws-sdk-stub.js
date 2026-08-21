// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Test stub for the AWS SDK clients that the handler dynamic-imports but that are
// NOT devDependencies of this package (they exist only in the Lambda runtime):
//   @aws-sdk/client-sqs, @aws-sdk/client-codecommit
// jest's moduleNameMapper points both specifiers here (see package.json). The
// `send` implementations are read from globalThis so the test file can install
// jest.fn() mocks and assert on the commands the handler issues. Each command
// "constructor" tags its input with a `__type` discriminator for those assertions.

export class SQSClient {
  send(command) { return globalThis.__sqsSend(command); }
}
export function GetQueueAttributesCommand(input) { return { __type: 'GetQueueAttributes', ...input }; }
export function ListMessageMoveTasksCommand(input) { return { __type: 'ListMessageMoveTasks', ...input }; }
export function StartMessageMoveTaskCommand(input) { return { __type: 'StartMessageMoveTask', ...input }; }

export class CodeCommitClient {
  send(command) { return globalThis.__ccSend(command); }
}
export function GetCommitCommand(input) { return { __type: 'GetCommit', ...input }; }
