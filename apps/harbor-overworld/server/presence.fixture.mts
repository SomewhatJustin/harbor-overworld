import assert from 'node:assert/strict';
import { sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Content } from '../../../packages/js-core/src/proto/polycentric/v2/content.ts';
import { EventKey } from '../../../packages/js-core/src/proto/polycentric/v2/event_key.ts';
import {
  Event,
  EventBundle,
  SignedEvent,
} from '../../../packages/js-core/src/proto/polycentric/v2/events.ts';
import {
  GetExploreFeedRequest,
  GetFeedResponse,
  GetPostRequest,
  GetPostResponse,
} from '../../../packages/js-core/src/proto/polycentric/v2/feeds.ts';
import { SortPostsBy } from '../../../packages/js-core/src/proto/polycentric/v2/search.ts';

export { createCrown } from '../src/world/crown.ts';
export { EYE_HEIGHT, RESPAWN_RADIUS } from '../src/world/movement.ts';
export { HIT_LINES } from '../src/world/presence-protocol.ts';
export { ground, SPAWN, WATER } from '../src/world/terrain.ts';
const author = 'ab'.repeat(32);
export const resetTime = Date.parse('2026-11-20T09:00:00.000Z');

function makeBundle(
  key: EventKey,
  content: Content,
  application?: string,
): EventBundle {
  const event = Event.create({
    key,
    createdAt: BigInt(resetTime - 1000),
    application: application ? { id: application } : undefined,
  });
  return EventBundle.create({
    signedEvent: { eventBytes: Event.toBinary(event) },
    serializedContent: { contentBytes: Content.toBinary(content) },
  });
}

function makePost(signerKey: string, sequence: bigint, application: string) {
  const key = EventKey.create({
    identity: author,
    collection: 2,
    sequence,
    signedBy: { keyType: 1, key: Buffer.from(signerKey, 'hex') },
  });
  const content = Content.create({
    contentBody: { oneofKind: 'post', post: { text: 'A test post' } },
  });
  const bundle = makeBundle(key, content, application);
  return {
    sequence,
    bundle,
    id: Buffer.from(EventKey.toBinary(key)).toString('hex'),
    paper: Buffer.from(EventBundle.toBinary(bundle)).toString('base64'),
  };
}

export function postFixtures(signerKey: string) {
  return {
    worldPost: makePost(signerKey, 1n, 'how.justin.harbor-overworld'),
    regularPost: makePost(signerKey, 2n, 'org.futo.harbor'),
  };
}

export function signHeader(
  post: ReturnType<typeof makePost>,
  privateKey: KeyObject,
) {
  const eventBytes = post.bundle.signedEvent!.eventBytes;
  return Buffer.from(
    SignedEvent.toBinary({
      eventBytes,
      signature: sign(null, eventBytes, privateKey),
    }),
  ).toString('base64');
}

function grpcFrame(flag: number, payload: Uint8Array) {
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function grpcResponse(payload: Uint8Array) {
  return new Response(
    new Uint8Array(
      Buffer.concat([
        grpcFrame(0, payload),
        grpcFrame(128, Buffer.from('grpc-status: 0\r\n')),
      ]),
    ),
    { headers: { 'content-type': 'application/grpc-web+proto' } },
  );
}

export function exploreFeedResponse(payload: Uint8Array, postSigner: string) {
  const request = GetExploreFeedRequest.fromBinary(payload);
  assert.equal(request.pageParams?.limit, 50);
  assert.equal(request.sortBy, SortPostsBy.LATEST);
  const next = request.pageParams?.forwardToken;
  if (next) assert.equal(next, 'regular-posts');
  const { worldPost, regularPost } = postFixtures(postSigner);
  return grpcResponse(
    GetFeedResponse.toBinary(
      GetFeedResponse.create({
        eventBundles: [next ? regularPost.bundle : worldPost.bundle],
        pageInfo: next
          ? undefined
          : { hasNextPage: true, endCursor: 'regular-posts' },
      }),
    ),
  );
}

export function mockHarbor(clockFile: string, postSigner: string) {
  Date.now = () => Number(readFileSync(clockFile, 'utf8'));
  const { worldPost, regularPost } = postFixtures(postSigner);
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return fetch(input, init);
    assert.ok(
      ['srv.harbor.social', 'srv.polycentric.io'].includes(url.hostname),
    );
    assert.ok(init?.body instanceof Uint8Array);
    const payload = init.body.subarray(5);
    switch (url.pathname.split('/').pop()) {
      case 'GetExploreFeed':
        return exploreFeedResponse(payload, postSigner);
      case 'GetPost': {
        const request = GetPostRequest.fromBinary(payload);
        const post = [worldPost, regularPost].find(
          ({ sequence }) =>
            request.identity === author && sequence === request.sequence,
        );
        return grpcResponse(
          GetPostResponse.toBinary(
            GetPostResponse.create({ candidates: post ? [post.bundle] : [] }),
          ),
        );
      }
      default:
        throw new Error(`Unexpected test request: ${url}`);
    }
  };
}
