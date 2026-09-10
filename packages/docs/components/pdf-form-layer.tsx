"use client";
import {
	AnnotationLayer,
	CanvasLayer,
	Page,
	Pages,
	TextLayer,
} from "@anaralabs/lector";
import { type FormEvent, useState } from "react";
import { ExampleRoot } from "./example-root";

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
			<div key={key} className="mb-4 bg-background rounded-lg p-4 shadow-sm">
				<div className="text-sm text-muted-foreground mb-1">
					{formatFieldName(key)}
				</div>
				<div className="text-base font-medium break-all">{String(value)}</div>
			</div>
		));
	};

	return (
		<div className="not-prose flex w-full min-w-0 flex-col gap-4 sm:flex-row">
			<div className="min-w-0 flex-1">
				<form onSubmit={handleSubmit}>
					<button
						type="submit"
						className="mb-4 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
					>
						Get form values
					</button>

					<ExampleRoot
						source={fileUrl}
						className="bg-muted border rounded-md overflow-hidden relative h-[700px]"
						loader={<div className="p-4">Loading...</div>}
					>
						<Pages className="p-4 h-full">
							<Page>
								<CanvasLayer />
								<TextLayer />
								<AnnotationLayer />
							</Page>
						</Pages>
					</ExampleRoot>
				</form>
			</div>

			<div
				className={`p-4 border-t sm:border-l sm:border-t-0 bg-muted transition-all duration-300 ${
					!formValues || Object.keys(formValues).length === 0
						? "w-full sm:w-48"
						: "w-full sm:w-56"
				}`}
			>
				<h2 className="text-lg font-semibold mb-4">Filled Form Values</h2>
				{formValues && Object.keys(formValues).length > 0 ? (
					<div className="space-y-2 max-h-[calc(100vh-8rem)] overflow-y-auto pr-2">
						{renderFormValues()}
					</div>
				) : (
					<p className="text-muted-foreground">
						No form values have been entered yet
					</p>
				)}
			</div>
		</div>
	);
};

export default PdfFormLayer;
