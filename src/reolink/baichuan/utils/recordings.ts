export const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const xmlDateTimePayload = (tag: "startTime" | "endTime", d: Date): string => {
  // Use local time methods - the camera expects dates in local time format.
  return `<${tag}><year>${d.getFullYear()}</year><month>${d.getMonth() + 1}</month><day>${d.getDate()}</day><hour>${d.getHours()}</hour><minute>${d.getMinutes()}</minute><second>${d.getSeconds()}</second></${tag}>`;
};
