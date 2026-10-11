// What Find says when something goes wrong (SDS section 9). Every sentence also goes through the SR-2 wording test.
// "Not found" is a limit of the search, never a statement about the room (SR-11).
import type { LocateClientErrorCode } from './locateClient'

export const FIND_MESSAGES: Record<LocateClientErrorCode | 'notFound', string> = {
  network: "I can't reach the internet, so I can't search.",
  timeout: 'The search took too long. Try again.',
  quota: 'The search service is busy. Try again in a moment.',
  auth: 'Find is not set up on this app yet.',
  bad_response: 'I could not understand the search result. Try again.',
  bad_request: 'I could not send that picture. Try again.',
  too_soon: 'One moment. Try again in a few seconds.',
  limit: 'I have searched a lot just now. Wait a minute and try again.',
  notFound: 'I could not find it.',
}

export function describeLocateError(code: LocateClientErrorCode): string {
  return FIND_MESSAGES[code]
}
