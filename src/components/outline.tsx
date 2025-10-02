import type { RefProxy } from "pdfjs-dist/types/src/display/api";
import {
	cloneElement,
	type FunctionComponent,
	type HTMLProps,
	type ReactElement,
	useCallback,
} from "react";

import { usePdfJump } from "../hooks/pages/usePdfJump";
import { usePDFOutline } from "../hooks/usePdfOutline";
import { usePdf } from "../internal";
import { Primitive } from "./primitive";

type OutlineItemType = NonNullable<ReturnType<typeof usePDFOutline>>[number];

export const OutlineChildItems = ({
	...props
}: HTMLProps<HTMLUListElement> & {
	children?: ReactElement<typeof OutlineItem>[];
}) => {
	return <Primitive.ul {...props} />;
};

interface OutlineItemProps extends HTMLProps<HTMLDivElement> {
	level?: number;
	item?: OutlineItemType;
	children?: ReactElement<typeof OutlineChildItems>;
	outlineItem?: ReactElement<typeof OutlineItem>;
}

export const OutlineItem: FunctionComponent<OutlineItemProps> = ({
	level = 0,
	item,
	children,
	outlineItem,
	...props
}: OutlineItemProps) => {
	if (!item || !outlineItem || !children) {
		throw new Error("Outline item is required");
	}

	const pdfDocumentProxy = usePdf((state) => state.pdfDocumentProxy);
	const { jumpToPage } = usePdfJump();

	const getDestinationPage = useCallback(
		async (dest: string | unknown[] | Promise<unknown[]>) => {
			let explicitDest: unknown[] | null;

			if (typeof dest === "string") {
				explicitDest = await pdfDocumentProxy.getDestination(dest);
			} else if (Array.isArray(dest)) {
				explicitDest = dest;
			} else {
				explicitDest = await dest;
			}

			if (!explicitDest) {
				return;
			}

			const explicitRef = explicitDest[0] as RefProxy;

			const page = await pdfDocumentProxy.getPageIndex(explicitRef);

			return page;
		},
		[pdfDocumentProxy],
	);

	const navigate = useCallback(() => {
		if (!item.dest) {
			return;
		}

		getDestinationPage(item.dest).then((page) => {
			if (!page) {
				return;
			}

			jumpToPage(page, { behavior: "smooth" });
		});
	}, [item.dest, jumpToPage, getDestinationPage]);

	return (
		<Primitive.li {...props}>
			<a
				role="button"
				tabIndex={0}
				onClick={navigate}
				onKeyUp={(e) => {
					if (e.key === "Enter") {
						navigate();
					}
				}}
				data-level={level}
			>
				{item.title}
			</a>
			{item.items &&
				item.items.length > 0 &&
				cloneElement(children, {
					// @ts-expect-error we are missing the corect props types
					children: item.items.map((item, index) =>
						cloneElement(outlineItem, {
							// @ts-expect-error we are missing the corect props types
							level: level + 1,
							item,
							outlineItem,
							// biome-ignore lint/suspicious/noArrayIndexKey: <stuff>
							key: index,
						}),
					),
				})}
		</Primitive.li>
	);
};

export const Outline = ({
	children,
	...props
}: HTMLProps<HTMLUListElement> & {
	children: ReactElement<typeof OutlineItem>;
}) => {
	const outline = usePDFOutline();

	return (
		<Primitive.ul {...props}>
			{outline?.map((item: OutlineItemType, idx) => {
				return cloneElement(children, {
					key: idx,
					item,
					outlineItem: children,
				} as OutlineItemProps);
			})}
		</Primitive.ul>
	);
};
