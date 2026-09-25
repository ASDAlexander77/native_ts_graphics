function adder(a = 0, b = 0) {
    return a + b;
}

class Adder {
	#a: int;
	#b: int;

	constructor(a: int, b: int) {
		this.#a = a;
		this.#b = b;
	}

	get result() { return adder(this.#a, this.#b); }
}

function foo_add(a: int, b: int): int {
    const adder = new Adder(a, b);
    return adder.result;
}

function foo_hello() {
    console.log("hello from foo");
}

function main() {
    foo_hello();
    print(`foo_add(2,3) = ${foo_add(2, 3)}`);
    return 0;
}
