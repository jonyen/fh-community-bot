export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function findRoomConflicts(request, events) {
  const conflicts = [];
  let skipped = 0;
  for (const ev of events) {
    if (ev.room !== request.room) continue;
    if (ev.startMin === null || ev.endMin === null) {
      skipped += 1;
      continue;
    }
    if (ev.allDay) {
      conflicts.push(ev);
      continue;
    }
    if (intervalsOverlap(request.startMin, request.endMin, ev.startMin, ev.endMin)) {
      conflicts.push(ev);
    }
  }
  return { conflicts, skipped };
}
