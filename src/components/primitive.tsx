import { type ComponentPropsWithRef, forwardRef } from "react";

const HTMLTags = [
	"a",
	"button",
	"div",
	"aside",
	"section",
	"main",
	"ul",
	"li",
	"input",
	"canvas",
] as const;
type HTMLTag = (typeof HTMLTags)[number];

type PrimitiveProps<E extends HTMLTag> = Omit<ComponentPropsWithRef<E>, "ref"> &
	Required<Pick<ComponentPropsWithRef<E>, "ref">>;

const makePrimitive = (htmlTag: HTMLTag) => {
	const primitive = forwardRef(
		(props: Omit<PrimitiveProps<typeof htmlTag>, "ref">, ref) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const Renderer: any = htmlTag;

			return <Renderer {...props} ref={ref} />;
		},
	);

	primitive.displayName = `PDFReader.${htmlTag}`;

	return primitive;
};

export type Primitives = {
	[tag in HTMLTag]: ReturnType<typeof makePrimitive>;
};

export const Primitive = HTMLTags.reduce((acc, tag) => {
	acc[tag] = makePrimitive(tag);
	return acc;
}, {} as Primitives);
