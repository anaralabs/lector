export function documentationResponse(
	content: string,
	contentType = "text/markdown",
) {
	return new Response(content, {
		headers: {
			"Content-Type": `${contentType}; charset=utf-8`,
			"Cache-Control": "public, max-age=0, must-revalidate",
			"Access-Control-Allow-Origin": "*",
			"X-Content-Type-Options": "nosniff",
			Link: '</lector/llms.txt>; rel="describedby"',
		},
	});
}
