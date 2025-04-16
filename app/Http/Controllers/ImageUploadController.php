<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\Log;

class ImageUploadController extends Controller
{
    /**
     * Handle the upload of images.
     *
     * @param  \Illuminate\Http\Request  $request
     * @return \Illuminate\Http\JsonResponse
     */
    public function uploadImages(Request $request)
    {
        try {
            $request->validate([
                'images.*' => 'required|image|mimes:jpeg,png,jpg,gif|max:10240', // 10MB max
            ]);

            $uploadedImages = [];
            
            if ($request->hasFile('images')) {
                foreach ($request->file('images') as $image) {
                    $path = $image->store('chat-images', 'public');
                    $uploadedImages[] = [
                        'path' => $path,
                        'url' => Storage::url($path),
                        'name' => $image->getClientOriginalName(),
                        'contentType' => $image->getMimeType(),
                    ];
                }
            }

            return response()->json([
                'success' => true,
                'images' => $uploadedImages,
            ]);
        } catch (\Exception $e) {
            Log::error('Image upload failed: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'Failed to upload images: ' . $e->getMessage(),
            ], 500);
        }
    }
} 