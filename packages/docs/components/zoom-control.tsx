'use client'

import {
  CanvasLayer,
  CurrentZoom,
  Page,
  Pages,
  Root,
  TextLayer,
  ZoomIn,
  ZoomOut,
  ZoomToFit
} from '@anaralabs/lector'

import '@/lib/setup'

const fileUrl = '/pdf/large.pdf'

const ViewerZoomControl = () => {
  return (
    <Root
      source={fileUrl}
      className="bg-gray-100 border rounded-md overflow-hidden relative h-[500px] flex flex-col justify-stretch"
      loader={<div className="p-4">Loading...</div>}
    >
      <div className="flex items-center justify-center gap-2 p-1 text-sm text-gray-600 bg-gray-100 border-b">
        Zoom
        <ZoomOut className="px-3 py-1 -mr-2 text-gray-900">-</ZoomOut>
        <CurrentZoom className="w-16 px-3 py-1 text-center bg-white border rounded-full" />
        <ZoomIn className="px-3 py-1 -ml-2 text-gray-900">+</ZoomIn>
        <ZoomToFit className="px-3 py-1 -ml-2 text-gray-900">Fit</ZoomToFit>
      </div>
      <Pages className="h-full p-4">
        <Page>
          <CanvasLayer />
          <TextLayer />
        </Page>
      </Pages>
    </Root>
  )
}

export default ViewerZoomControl
