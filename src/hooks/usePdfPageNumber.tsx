import { createContext, useContext } from "react";

export interface PDFPageNumberType {
	pageNumber: number;
}

export const PDFPageNumberContext = createContext<number>(0);

export const usePDFPageNumber = () => {
	return useContext(PDFPageNumberContext);
};
