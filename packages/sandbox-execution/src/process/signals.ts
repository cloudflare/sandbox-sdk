import { constants } from 'node:os';

export function validateSignal(signal = 15): number {
  if (!Number.isInteger(signal) || signal < 1 || signal > 64) {
    throw new RangeError('signal must be an integer from 1 through 64');
  }
  return signal;
}

export function observedSignalNumber(
  signalCode: NodeJS.Signals | number | null
): number | undefined {
  if (signalCode === null) return undefined;
  // Bun reports a signal without a name, such as a Linux real-time signal,
  // as its number.
  const signal =
    typeof signalCode === 'number' ? signalCode : constants.signals[signalCode];
  if (signal === undefined || !Number.isInteger(signal) || signal < 1) {
    throw new Error(`Unknown observed process signal: ${signalCode}`);
  }
  return signal;
}
