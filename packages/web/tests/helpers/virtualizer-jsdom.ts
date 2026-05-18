import { afterEach, vi } from "vitest";

const ROW_HEIGHT_PX = 360;

/**
 * Makes @tanstack/react-virtual usable under jsdom:
 * - a synchronous ResizeObserver mock,
 * - a fixed clientWidth/clientHeight viewport,
 * - getBoundingClientRect returning the viewport for the scroll element and a
 *   fixed row height for measured rows (elements with a data-index attribute).
 *
 * Call inside a `beforeEach`. State is restored automatically via afterEach.
 */
export function installVirtualizerJsdomEnv(
  viewport: { width: number; height: number } = { width: 900, height: 600 },
): void {
  class ResizeObserverMock {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(el: Element): void {
      this.cb([{ target: el } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);

  const widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const offsetWidthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const offsetHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const originalRect = HTMLElement.prototype.getBoundingClientRect;

  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(): number {
      return viewport.width;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(): number {
      return viewport.height;
    },
  });
  // @tanstack/virtual-core's getRect() uses offsetWidth/offsetHeight to measure
  // the scroll container — mock these alongside clientWidth/clientHeight so the
  // virtualizer sees a non-zero container size in jsdom.
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(): number {
      return viewport.width;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(): number {
      return viewport.height;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    const isRow = (this as HTMLElement).dataset?.index !== undefined;
    const height = isRow ? ROW_HEIGHT_PX : viewport.height;
    return {
      width: viewport.width,
      height,
      top: 0,
      left: 0,
      right: viewport.width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    if (widthDesc) Object.defineProperty(HTMLElement.prototype, "clientWidth", widthDesc);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    if (heightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", heightDesc);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    if (offsetWidthDesc) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidthDesc);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
    if (offsetHeightDesc) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDesc);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  });
}
