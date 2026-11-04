import { z } from 'zod';
const text = z.string().min(1).max(2000);
const uuid = z.string().uuid();
export const intentSchema = z.object({ task: text,
  files: z.array(text).max(100), symbols: z.array(text).max(100),
  assumptions: z.array(z.object({ key: text, value: text })).max(100) });
export const proposeSchema = z.object({
  title: text,
  declaration: z.string().min(1).max(16000),
  participants: z.array(uuid).min(1).max(10),
  producerSymbol: text.optional(),
  behaviorNotes: z.string().max(4000).optional(),
});
export const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add_field'), symbol: text, name: text, type: text, optional: z.boolean().default(false) }),
  z.object({ kind: z.literal('change_signature'), symbol: text, declaration: z.string().min(1).max(4000) }),
  z.object({ kind: z.literal('rename_symbol'), symbol: text, newName: text }),
  z.object({ kind: z.literal('add_endpoint'), file: text, method: text, route: text, responseType: text }),
]);
const commitId = z.string().regex(/^[0-9a-f]{7,64}$/i);
const userCode = z.string().trim().min(8).max(20);
export const repoSchema = z.object({ name: z.string().trim().min(1).max(120), identity: z.string().max(300).nullable().optional(),
  remoteUrl: z.string().max(500).nullable().optional(), rootCommit: commitId.nullable().optional() });
export const claimRuleSchema = z.object({ kind: z.literal('field_required'), symbol: text, field: text, type: text.optional(), note: z.string().max(2000).optional() });
export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('register'), name: text, workspace: text.optional(), client: text.optional() }),
  z.object({ action: z.literal('heartbeat'), sessionId: uuid }),
  z.object({ action: z.literal('finish'), sessionId: uuid }),
  z.object({ action: z.literal('intent'), sessionId: uuid, intent: intentSchema }),
  z.object({ action: z.literal('propose'), sessionId: uuid, ...proposeSchema.shape }),
  z.object({ action: z.literal('acknowledge'), sessionId: uuid, contractId: uuid, version: z.number().int().positive() }),
  z.object({ action: z.literal('revise'), sessionId: uuid, contractId: uuid, title: text.optional(),
    declaration: z.string().min(1).max(16000).optional(), behaviorNotes: z.string().max(4000).optional() }),
  z.object({ action: z.literal('reject'), sessionId: uuid, contractId: uuid, reason: text }),
  z.object({ action: z.literal('reindex'), sessionId: uuid }),
  z.object({ action: z.literal('symbol'), sessionId: uuid, reference: text }),
  z.object({ action: z.literal('preview'), sessionId: uuid, operation: operationSchema }),
  z.object({ action: z.literal('apply'), sessionId: uuid, proposalId: uuid }),
  z.object({ action: z.literal('contract_check'), sessionId: uuid, contractId: uuid }),
  z.object({ action: z.literal('verify'), sessionId: uuid, contractId: uuid, command: text }),
  // Status of a verification run. With sessionId (the MCP tools always send it) the session is heartbeated and must be the caller's.
  z.object({ action: z.literal('verify_status'), runId: uuid, sessionId: uuid.optional() }),
  z.object({ action: z.literal('claim'), sessionId: uuid, rule: claimRuleSchema }),
  z.object({ action: z.literal('analyze'), sessionId: uuid, force: z.boolean().optional() }),
  // Hook actions: authenticated by the shared token only; a hook process has no MCP session of its own.
  z.object({ action: z.literal('sync') }),
  z.object({ action: z.literal('hook_check'), file: text, clientSession: text.optional() }),
  // Laptop sync (member or admin; the caller's member name owns the files). Content null = deleted.
  z.object({ action: z.literal('remote_status') }),
  z.object({ action: z.literal('remote_push'), baseCommit: z.string().max(80).nullable().optional(), replace: z.boolean().optional(),
    files: z.array(z.object({ path: text, content: z.string().max(262144).nullable() })).max(200) }),
  // Laptop relay for model analysis (when this host is not offered the model).
  z.object({ action: z.literal('analysis_relay_request') }),
  // Admin only: probes the model provider from this hub (GET /models + a one-token chat completion) and keeps the result.
  z.object({ action: z.literal('model_diagnose') }),
  z.object({ action: z.literal('analysis_relay_submit'), inputHash: z.string().min(1).max(200), httpStatus: z.number().int(),
    responseText: z.string().max(1_000_000), latencyMs: z.number().int().nonnegative() }),
  z.object({ action: z.literal('remote_check'), baseCommit: z.string().max(80).nullable().optional(),
    path: text, content: z.string().max(262144).nullable() }),
  // Members and tokens. token_* are admin-only (src/server/auth.ts); the token value is returned once by token_create.
  z.object({ action: z.literal('member_list') }),
  z.object({ action: z.literal('token_create'), label: z.string().trim().min(1).max(80), member: z.string().trim().min(1).max(80),
    role: z.enum(['admin', 'member', 'viewer']), kind: z.enum(['member', 'connector', 'viewer-link']).optional() }),
  z.object({ action: z.literal('token_list') }),
  z.object({ action: z.literal('token_rename'), tokenId: uuid, label: z.string().trim().min(1).max(80) }),
  z.object({ action: z.literal('token_revoke'), tokenId: uuid }),
  // Hive Connect pairing (src/server/pairing.ts). pair_start and pair_poll are the only unauthenticated commands.
  z.object({ action: z.literal('pair_start'), repo: repoSchema, machine: z.string().trim().min(1).max(80), client: z.string().max(40).nullable().optional() }),
  z.object({ action: z.literal('pair_poll'), pairingId: uuid, pollSecret: z.string().min(1).max(200) }),
  z.object({ action: z.literal('pair_info'), userCode: userCode }),
  // member: admin only, to approve on behalf of another member (src/server/auth.ts).
  z.object({ action: z.literal('pair_approve'), userCode: userCode, member: z.string().trim().min(1).max(80).optional() }),
  z.object({ action: z.literal('pair_deny'), userCode: userCode }),
  // Checkout report from the local connector (src/server/checkouts.ts validates paths and hashes again).
  z.object({ action: z.literal('checkout_report'), repo: repoSchema, branch: z.string().max(200).nullable().optional(),
    head: commitId.nullable().optional(), baseCommit: commitId.nullable().optional(), machine: z.string().max(80).nullable().optional(),
    dirty: z.array(z.object({ path: z.string().min(1).max(1000), sha256: z.string().regex(/^[0-9a-f]{64}$/i).nullable(),
      status: z.string().max(20).optional() })).max(500) }),
  // Revokes the caller's own connector credential (tokenId optional for a connector; a member names one of theirs).
  z.object({ action: z.literal('connector_disconnect'), tokenId: uuid.optional() }),
]);
export type Command = z.infer<typeof commandSchema>;
