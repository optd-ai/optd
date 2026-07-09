const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
console.log(JSON.stringify({ operations: [] }));
