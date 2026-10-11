// What Find says when something goes wrong (SDS section 9). Every sentence also goes through the SR-2 wording test.
// "Not found" is a limit of the search, never a statement about the room (SR-11).
import type { LocateErrorKind } from './locateTypes'

export const FIND_MESSAGES: Record<LocateErrorKind | 'notFound', string> = {
  network: "I can't reach the internet, so I can't search.",
  timeout: 'The search took too long. Try again.',
  'rate-limited': 'The search service is busy. Try again in a moment.',
  unavailable: 'The search service did not answer. Try again.',
  'bad-reply': 'I could not understand the search result. Try again.',
  'not-configured': 'Find is not set up on this app yet.',
  'bad-request': 'I could not send that picture. Try again.',
  notFound: 'I could not find it.',
}

export function describeLocateError(kind: LocateErrorKind): string {
  return FIND_MESSAGES[kind]
}
