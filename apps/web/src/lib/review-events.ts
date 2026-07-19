import type { ReviewJobSnapshot } from "@/lib/review-presentation";

export function encodeReviewProgressEvent(snapshot: ReviewJobSnapshot) {
  return `retry: 3000\nevent: progress\nid: ${snapshot.observedAt}\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

export function encodeReviewHeartbeat(observedAt: string) {
  return `: review progress observed ${observedAt}\n\n`;
}
