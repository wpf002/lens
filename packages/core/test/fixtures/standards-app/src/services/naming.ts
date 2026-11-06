export function parseOrder(raw: string) {
  return raw.trim();
}

export function formatOrder(id: string) {
  return `#${id}`;
}

export function validateOrder(id: string) {
  return id.length > 0;
}

export function save_order(id: string) {
  return { id };
}
