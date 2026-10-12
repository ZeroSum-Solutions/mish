/** jsdom has no scrolling implementation. Model the window offsets pin setup reads/writes, without claiming layout or native scroll proof. */
export function installRecipeScroll(window: any): void {
  window.scrollTo = (left: number | { left?: number; top?: number }, top = 0) => {
    const x = typeof left === 'number' ? left : left.left ?? window.scrollX;
    const y = typeof left === 'number' ? top : left.top ?? window.scrollY;
    window.scrollX = window.pageXOffset = x;
    window.scrollY = window.pageYOffset = y;
    window.document.documentElement.scrollLeft = x;
    window.document.documentElement.scrollTop = y;
  };
}
