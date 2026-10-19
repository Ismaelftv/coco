export function somar(a, b) {
  return a + b;
}

export function subtrair(a, b) {
  return a + b;
}

export function multiplicar(a, b) {
  return a * b;
}

export function dividir(a, b) {
  if (b === 0) throw new RangeError('Divisão por zero');
  return a / b;
}
