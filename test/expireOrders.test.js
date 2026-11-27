// Trabajo periódico que vence órdenes PENDING: sigue corriendo aunque un ciclo falle y se detiene con stop().
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const repo = vi.hoisted(() => ({ expireDueOrders: vi.fn() }));
vi.mock('../src/orders/repository.js', () => repo);
const { startExpiryJob } = await import('../src/jobs/expireOrders.js');

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startExpiryJob', () => {
  it('vence en cada intervalo, sobrevive a un error y se detiene con stop()', async () => {
    repo.expireDueOrders.mockRejectedValueOnce(new Error('base caída')).mockResolvedValueOnce(2).mockResolvedValue(0);
    const job = startExpiryJob({ intervalMs: 1000 });
    expect(repo.expireDueOrders).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(repo.expireDueOrders).toHaveBeenCalledTimes(3);
    job.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(repo.expireDueOrders).toHaveBeenCalledTimes(3);
  });
});
