type ListingEvent = { symbol: string; [key: string]: unknown };
type ListingCallback = (event: ListingEvent) => Promise<void>;

class ListingMonitor {
  private callbacks: ListingCallback[] = [];
  private running = false;

  onListing(cb: ListingCallback) {
    this.callbacks.push(cb);
  }

  isRunning(): boolean {
    return this.running;
  }

  start() {
    if (this.running) return;
    this.running = true;
    // TODO: implement listing monitor polling logic
  }

  stop() {
    this.running = false;
    // TODO: implement listing monitor stop logic
  }
}

export const listingMonitor = new ListingMonitor();
