/* Read-only UI state for the native calculator nodes inside a Worker. */
const workerElements = new Map();
function workerElement(data = {}) {
  return {
    value: data.value ?? '0', children: (data.children || []).map(workerElement), id: data.id,
    classList: {contains: name => name === 'toggleOn' && !!data.on, add() {}},
    style: {}, addEventListener() {}, append() {}, appendChild() {}, setAttribute() {},
  };
}
self.document = {
  getElementById: id => workerElements.get(id) || workerElement(),
  createElement: () => workerElement(),
  addEventListener() {},
};
self.screen = {width: 1920};
