async function* stream_data() {
    yield "start";

    await new Promise(resolve => setTimeout(resolve, 1000));
    yield "middle";

    await new Promise(resolve => setTimeout(resolve, 1000));
    yield "end";

    return "done";
}

const gen = stream_data();

for await (const item of gen) {
    console.log(item);
}

const result = await gen.next();
console.log(result);

console.log("===========================")


const gen2 = stream_data();
let result2 = await gen2.next();
while (!result2.done) {
    console.log(result2.value);
    result2 = await gen2.next();
}
console.log(result2.value);


export { };
