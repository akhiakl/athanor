// Viewport lock, spec 6.3. CSS/meta cover most of it (index.html); these listeners cover what CSS cannot.
export function lockViewport(stage: HTMLElement): void {
  const stop = (e: Event): void => e.preventDefault();
  // iOS Safari ignores user-scalable=no (since iOS 10): block multi-touch pinch on the stage and the proprietary gesture events.
  const pinch = (e: TouchEvent): void => {
    if (e.touches.length > 1) e.preventDefault();
  };
  stage.addEventListener('touchstart', pinch, { passive: false });
  stage.addEventListener('touchmove', pinch, { passive: false });
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, stop);
  stage.addEventListener('contextmenu', stop); // right button still reaches modules as buttons & 2
  stage.addEventListener('dragstart', stop);
}
