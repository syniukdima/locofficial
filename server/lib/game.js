export const COLORS = ["R", "G", "B", "Y"];

export function createDeck() {
  /** @type {{ color: string, value: number }[]} */
  const deck = [];
  for (const color of COLORS) {
    deck.push({ color, value: 0 });
    for (let v = 1; v <= 9; v++) {
      deck.push({ color, value: v });
      deck.push({ color, value: v });
    }
  }
  return deck;
}

export function shuffleInPlace(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
  return array;
}

export function cardEquals(a, b) {
  return a && b && a.color === b.color && a.value === b.value;
}

export function canPlay(card, top) {
  if (!card || !top) return false;
  return card.color === top.color || card.value === top.value;
}



