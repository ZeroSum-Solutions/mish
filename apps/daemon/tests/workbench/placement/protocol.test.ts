import { describe, expect, it } from 'vitest';
import { parsePlacementReply, validPlacementName } from '../../../src/workbench/placement/protocol.js';

describe('exclusive-placement protocol', () => {
  it('rejects traversal, control bytes, malformed UTF16 and overlong basenames', () => {
    for (const name of ['', '.', '..', '../x', '/x', 'x/y', 'x\0y', 'x\ny', '\ud800', 'é'.repeat(128)]) {
      expect(validPlacementName(name)).toBe(false);
    }
    expect(validPlacementName('native résumé.tsx')).toBe(true);
  });
  it('treats malformed, duplicate, unbounded or mismatched replies as unknown', () => {
    for (const body of ['', '{}', '{"version":1,"version":1}', 'x'.repeat(8193), '{"version":2}']) {
      expect(parsePlacementReply(body, '12345678-1234-4234-8234-123456789abc')).toBeNull();
    }
  });
  it('does not round a device or inode through a JavaScript number', () => {
    const parent = { device: '16777230', inode: '9007199254740993', volumeUUID: '12345678-1234-4234-8234-123456789abc' };
    const reply = { version: 1, invocationId: '12345678-1234-4234-8234-123456789abc', status: 'qualified', reason: 'none', errno: 0, sourceParent: parent, targetParent: parent, sourceBefore: null, targetBefore: null, sourceAfter: null, targetAfter: null };
    expect(parsePlacementReply(JSON.stringify(reply), reply.invocationId)?.sourceParent?.inode).toBe('9007199254740993');
    expect(parsePlacementReply(JSON.stringify({ ...reply, sourceParent: { ...parent, inode: 9007199254740993 } }), reply.invocationId)).toBeNull();
    expect(parsePlacementReply(JSON.stringify({ ...reply, unexpected: true }), reply.invocationId)).toBeNull();
    expect(parsePlacementReply(JSON.stringify({ ...reply, errno: 1 }), reply.invocationId)).toBeNull();
    expect(parsePlacementReply(JSON.stringify({ ...reply, status: 'moved', reason: 'alias' }), reply.invocationId)).toBeNull();
    expect(parsePlacementReply(JSON.stringify({ ...reply, status: 'conflict', reason: 'rename', errno: 0 }), reply.invocationId)).toBeNull();
    expect(parsePlacementReply(JSON.stringify({ ...reply, status: ['qualified'] }), reply.invocationId)).toBeNull();
    const malformedObject = { device: '1', inode: '2', kind: ['file'], size: '0', mode: 0, links: 1, flags: 0 };
    expect(parsePlacementReply(JSON.stringify({ ...reply, sourceBefore: malformedObject }), reply.invocationId)).toBeNull();
  });
});
