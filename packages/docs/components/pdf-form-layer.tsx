"use client";
import {
	AnnotationLayer,
	CanvasLayer,
	Page,
	Pages,
	Root,
	TextLayer,
} from "@anaralabs/lector";
import { type FormEvent, useState } from "react";
import "@/lib/setup";

const fileUrl = "/pdf/form.pdf";

type FormValues = {
	[key: string]: FormDataEntryValue;
} | null;

const PdfFormLayer = () => {
	const [formValues, setFormValues] = useState<FormValues>(null);

	const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const formData = new FormData(e.currentTarget);

		// Filter out empty values and create a new object with only filled fields
		const values = Object.fromEntries(
			Array.from(formData.entries()).filter(([, value]) => {
				// Check for empty strings, undefined, or null
				return value !== "" && value != null;
			}),
		);

		setFormValues(Object.keys(values).length > 0 ? values : null);
	};

	const formatFieldName = (fieldName: string) => {
		// Remove array notation and split by underscores
		return fieldName
			.replace(/\[\d+\]/g, "")
			.split("_")
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ");
	};

	const renderFormValues = () => {
		if (!formValues) return null;

		return Object.entries(formValues).map(([key, value]) => (
			<div key={key} className="mb-4 bg-white rounded-lg p-4 shadow-sm">
				<div className="text-sm text-gray-600 mb-1">{formatFieldName(key)}</div>
				<div className="text-base font-medium break-all">{String(value)}</div>
			</div>
		));
	};

	return (
		<div className="flex w-full h-screen">
			<div className="flex-1">
				<form onSubmit={handleSubmit}>
					<button
						type="submit"
						className="mb-4 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
					>
						Get form values
					</button>

					<Root
						source={fileUrl}
						className="bg-gray-100 border rounded-md overflow-hidden relative h-[700px]"
						loader={<div className="p-4">Loading...</div>}
					>
						<Pages className="p-4 h-full">
							<Page>
								<CanvasLayer />
								<TextLayer />
								<AnnotationLayer />
							</Page>
						</Pages>
					</Root>
				</form>
			</div>

			<div
				className={`p-6 border-l bg-gray-50 transition-all duration-300 ${
					!formValues || Object.keys(formValues).length === 0 ? "w-64" : "w-1/3"
				}`}
			>
				<h2 className="text-lg font-semibold mb-4">Filled Form Values</h2>
				{formValues && Object.keys(formValues).length > 0 ? (
					<div className="space-y-2 max-h-[calc(100vh-8rem)] overflow-y-auto pr-2">
						{renderFormValues()}
					</div>
				) : (
					<p className="text-gray-500">No form values have been entered yet</p>
				)}
			</div>
		</div>
	);
};

export default PdfFormLayer;
