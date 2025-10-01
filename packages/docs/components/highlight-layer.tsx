"use client";

import {
	CanvasLayer,
	HighlightLayer,
	Page,
	Pages,
	Root,
	TextLayer,
	usePdfJump,
} from "@anaralabs/lector";
import { useState } from "react";
import "@/lib/setup";

const fileUrl = "/pdf/pathways.pdf";

const examples = [
	{
		id: 1,
		title: "Results",
		text: "Results: C-10, D-12, and E-13 tumors disseminated primarily by the hematogenous route and developed pulmonary metastases",
		highlights: [
			{
				height: 10.888885498046875,
				left: 63.06942749023375,
				pageNumber: 1,
				top: 438.73612976074,
				width: 465.831176757812,
			},
			{
				height: 10.666656494140625,
				left: 63.06942749023375,
				pageNumber: 1,
				top: 450.75001525878906,
				width: 45.268432617187,
			},
		],
	},
	{
		id: 2,
		title: "Methods",
		text: "Methods: Two patient-derived xenograft (PDX) models (E-13, N-15) and four cell line-derived xenografts (CDX) models (C-10, D-12, R-18, T-22) of human melanoma were included in the study.",
		highlights: [
			{
				height: 10.888885498046875,
				left: 63.06942749023375,
				pageNumber: 1,
				top: 351.83332824707,
				width: 441.37243652343,
			},
			{
				height: 10.666687011718,
				left: 63.06942749023375,
				pageNumber: 1,
				top: 363.84721374511,
				width: 318.05914306640625,
			},
		],
	},
	{
		id: 3,
		title: "Metastatic Frequency",
		text: "Metastatic frequency was determined by studying a fifty tumor-bearing mice of each melanoma model.",
		highlights: [
			{
				height: 10.666656494140625,
				left: 56.63888549804687,
				pageNumber: 4,
				top: 266.5972290039062,
				width: 233.84039306640625,
			},
			{
				height: 10.694458007812,
				left: 56.63888549804687,
				pageNumber: 4,
				top: 278.52777099609375,
				width: 233.8784179687,
			},
		],
	},
	{
		id: 4,
		title: "High IFP",
		text: "High IFP is mainly a consequence of high resistance to blood flow caused by tumor-induced vessel abnormalities and is likely facilitated by high expression of NRP2.",
		highlights: [
			{
				height: 10.666656494140625,
				left: 304.5694274902344,
				pageNumber: 10,
				top: 86.79124450683594,
				width: 233.48394775390625,
			},
			{
				height: 10.694458007812,
				left: 304.5694274902344,
				pageNumber: 10,
				top: 98.72178649902344,
				width: 233.86926269531,
			},
			{
				height: 10.666687011718,
				left: 304.5694274902344,
				pageNumber: 10,
				top: 110.73567199707031,
				width: 204.37457275390625,
			},
		],
	},
];

const HighlightLayerContent = () => {
	const { jumpToHighlightRects } = usePdfJump();
	const [selectedExample, setSelectedExample] = useState<string | null>(null);
	const handleExampleClick = async (example: (typeof examples)[0]) => {
		try {
			setSelectedExample(example.text);

			jumpToHighlightRects(example.highlights, "pixels", "center");
		} catch (error) {
			console.error("Error highlighting text:", error);
		}
	};

	return (
		<div className="flex">
			<div className="flex-1 relative">
				<Pages className="p-4">
					<Page>
						<CanvasLayer />
						<TextLayer />
						<HighlightLayer className="bg-yellow-200/70" />
					</Page>
				</Pages>
			</div>
			<div className="w-80 p-4 bg-white shadow-lg overflow-auto">
				<h2 className="text-lg font-bold mb-4">Important Sections</h2>
				<div className="space-y-4">
					{examples.map((example) => (
						<div
							key={example.id}
							onClick={() => handleExampleClick(example)}
							className={`p-3 border rounded cursor-pointer ${
								selectedExample === example.text
									? "bg-yellow-100"
									: "hover:bg-gray-50"
							}`}
						>
							<h3 className="font-semibold text-gray-800">{example.title}</h3>
							<p className="text-sm text-gray-600 mt-1">{example.text}</p>
						</div>
					))}
				</div>
			</div>
		</div>
	);
};

const PdfHighlightLayer = () => (
	<Root
		source={fileUrl}
		className="flex bg-gray-50 h-[500px]"
		loader={<div className="p-4">Loading...</div>}
	>
		<HighlightLayerContent />
	</Root>
);

export default PdfHighlightLayer;
