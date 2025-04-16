"use client"

import type React from "react"
import { useState, useRef, useEffect } from "react"
import AppSidebarLayout from "@/layouts/app/app-sidebar-layout"
import type { BreadcrumbItem } from "@/types"
import { Head, useForm } from "@inertiajs/react"
import { Image, Send, X, Loader2, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import axios from "axios"
import { createWorker } from 'tesseract.js'
import ReactMarkdown from 'react-markdown'

interface Message {
  id: string | number
  content: string
  role: "user" | "assistant"
  attachments?: Array<{
    url: string
    contentType: string
  }>
  isStreaming?: boolean
  extractedText?: string
}

interface Conversation {
  id: number
  title: string
  updated_at: string
}

interface Props {
  currentConversation?: {
    id: number
    title: string
  }
  messages?: Message[]
  conversations?: Conversation[]
}

const breadcrumbs: BreadcrumbItem[] = [
  { title: "VisionAI", href: "/chat" },

]

export default function Chat({ currentConversation, messages: initialMessages = [], conversations = [] }: Props) {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [imageFiles, setImageFiles] = useState<File[]>([])
  const [imagePreviews, setImagePreviews] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isExtracting, setIsExtracting] = useState(false)
  const [extractionStatus, setExtractionStatus] = useState('')
  const [extractedText, setExtractedText] = useState('')
  const eventSourceRef = useRef<EventSource | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const assistantMessageId = useRef<string | number>(Date.now())

  const { data, setData, reset } = useForm({
    message: "",
    images: [] as File[],
    conversation_id: currentConversation?.id || 0,
  })

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [])

  useEffect(() => {
    return () => eventSourceRef.current?.close()
  }, [])

  // Check for pending messages from new.tsx
  useEffect(() => {
    const pendingMessage = sessionStorage.getItem('pendingMessage');
    if (pendingMessage && currentConversation) {
      // Clear the pending message from sessionStorage
      sessionStorage.removeItem('pendingMessage');
      
      // Get any pending extracted text
      const pendingExtractedText = sessionStorage.getItem('pendingExtractedText');
      if (pendingExtractedText) {
        sessionStorage.removeItem('pendingExtractedText');
        setExtractedText(pendingExtractedText);
      }
      
      // Get any pending images
      let pendingImages: Array<{path: string, url: string, name: string, contentType?: string}> = [];
      const pendingImagesStr = sessionStorage.getItem('pendingImages');
      if (pendingImagesStr) {
        sessionStorage.removeItem('pendingImages');
        try {
          pendingImages = JSON.parse(pendingImagesStr);
        } catch (e) {
          console.error("Error parsing pending images:", e);
        }
      }
      
    
      
      // Check for text extraction feedback
      const textExtracted = sessionStorage.getItem('textExtracted');
      if (textExtracted) {
        sessionStorage.removeItem('textExtracted');
      }

      // Create temporary assistant message for streaming
      const tempAssistantMessage: Message = {
        id: `assistant-${Date.now()}`,
        content: "",
        role: "assistant",
        isStreaming: true,
      };
      
      assistantMessageId.current = tempAssistantMessage.id;
      setMessages(prev => [...prev, tempAssistantMessage]);
      setIsLoading(true);
      
      // Create query params for streaming
      const params = new URLSearchParams({
        message: pendingMessage,
        conversation_id: currentConversation.id.toString(),
      });
      
      // Add extracted text if available
      if (pendingExtractedText) {
        params.append('extracted_text', pendingExtractedText);
      }
      
      // Add image paths to params
      pendingImages.forEach(img => params.append('images[]', img.path));
      
      // Create new EventSource
      const eventSource = new EventSource(`/chat-stream?${params.toString()}`);
      eventSourceRef.current = eventSource;
      
      eventSource.onmessage = (event) => {
        const { content, finished } = JSON.parse(event.data);
        
        setMessages(prev => prev.map(msg => 
          msg.id === assistantMessageId.current ? {
            ...msg,
            content: msg.content + content,
            isStreaming: !finished
          } : msg
        ));
        
        if (finished) {
          eventSource.close();
          setIsLoading(false);
          
          // Fetch the conversation data to get the correct message IDs
          axios.get(`/api/conversations/${currentConversation.id}`)
            .then(response => {
              const conversationData = response.data;
              // Preserve message order by keeping existing messages and only updating IDs
              setMessages(prev => {
                const existingMessages = [...prev];
                const serverMessages = conversationData.messages;
                
                // Update message IDs while maintaining order
                return existingMessages.map(msg => {
                  const serverMsg = serverMessages.find(
                    (sMsg: Message) => sMsg.role === msg.role && sMsg.content === msg.content
                  );
                  return serverMsg || msg;
                });
              });
            })
            .catch(error => {
              console.error("Error fetching conversation data:", error);
            });
        }
      };
      
      eventSource.onerror = (error) => {
        console.error("Stream error:", error);
        eventSource.close();
        setIsLoading(false);
        setMessages(prev => prev.map(msg => 
          msg.id === assistantMessageId.current ? { ...msg, isStreaming: false } : msg
        ));
      };
    }
  }, [currentConversation]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return
    
    const newFiles = Array.from(e.target.files).slice(0, 3 - imageFiles.length)
    const updatedFiles = [...imageFiles, ...newFiles]
    
    setImageFiles(updatedFiles)
    setData("images", updatedFiles)
    setExtractedText('')
    setExtractionStatus('')

    newFiles.forEach(file => {
      const reader = new FileReader()
      reader.onload = (e : any) => {
        e.target?.result && setImagePreviews(prev => [...prev, e.target.result as string])
      }
      reader.readAsDataURL(file)
    })
  }

  const removeImage = (index: number) => {
    const updatedFiles = imageFiles.filter((_, i) => i !== index)
    setImageFiles(updatedFiles)
    setData("images", updatedFiles)
    setImagePreviews(prev => prev.filter((_, i) => i !== index))
    setExtractedText('')
    setExtractionStatus('')
  }

  const extractTextFromImage = async (imageFile: File): Promise<string> => {
    try {
      setExtractionStatus('Initializing text extraction...')
      const worker = await createWorker('eng');
      
      setExtractionStatus('Processing image...')
      const imageUrl = URL.createObjectURL(imageFile);
      const result = await worker.recognize(imageUrl);
      
      setExtractionStatus('Text extraction completed')
      await worker.terminate();
      
      console.log('Extraction result:', result);
      return result.data.text || '';
    } catch (error) {
      console.error('Error during text extraction:', error);
      setExtractionStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return '';
    }
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
    if (!data.message.trim() && !imageFiles.length) return

    // Extract text from images if present
    let extractedText = '';
    let textExtracted = false;
    if (imageFiles.length > 0) {
      setIsExtracting(true);
      setExtractionStatus('Starting text extraction...');
      
      // Extract text from each image
      for (let i = 0; i < imageFiles.length; i++) {
        setExtractionStatus(`Extracting text from image ${i + 1}/${imageFiles.length}...`);
        const text = await extractTextFromImage(imageFiles[i]);
        if (text) {
          extractedText += (extractedText ? '\n\n' : '') + text;
          textExtracted = true;
        }
      }
      
      setExtractedText(extractedText);
      setIsExtracting(false);
      
      
       
    }

    // Upload images first
    let uploadedImages: Array<{path: string, url: string, name: string, contentType?: string}> = []
    try {
      if (imageFiles.length > 0) {
        const formData = new FormData()
        imageFiles.forEach(file => formData.append('images[]', file))
        const response = await axios.post('/api/upload-images', formData)
        uploadedImages = response.data.images
      }
    } catch (error) {
      console.error("Image upload failed:", error)
      return
    }

    // Create a temporary user message to show immediately
    const tempUserMessage: Message = {
      id: `user-${Date.now()}`,
      content: data.message,
      role: "user",
      attachments: uploadedImages.map(img => ({
        url: img.url,
        contentType: img.contentType || "image/jpeg",
      })),
    };

    // Add the temporary user message to the UI
    setMessages(prev => [...prev, tempUserMessage]);

    // Create temporary assistant message
    const tempAssistantMessage: Message = {
      id: `assistant-${Date.now()}`,
      content: "",
      role: "assistant",
      isStreaming: true,
    }

    assistantMessageId.current = tempAssistantMessage.id
    setMessages(prev => [...prev, tempAssistantMessage])
    setIsLoading(true)

    try {
      // Create query params
      const params = new URLSearchParams({
        message: data.message,
        conversation_id: data.conversation_id.toString(),
      })
      
      // Add extracted text if available
      if (extractedText) {
        params.append('extracted_text', extractedText);
      }
      
      // Add image paths to params
      uploadedImages.forEach(img => params.append('images[]', img.path))

      // Close existing connection and create new EventSource
      eventSourceRef.current?.close()
      const eventSource = new EventSource(`/chat-stream?${params.toString()}`)
      eventSourceRef.current = eventSource

      eventSource.onmessage = (event) => {
        const { content, finished } = JSON.parse(event.data)
        
        setMessages(prev => prev.map(msg => 
          msg.id === assistantMessageId.current ? {
            ...msg,
            content: msg.content + content,
            isStreaming: !finished
          } : msg
        ))

        if (finished) {
          eventSource.close()
          setIsLoading(false)
          
          // Fetch the conversation data to get the correct message IDs
          axios.get(`/api/conversations/${data.conversation_id}`)
            .then(response => {
              const conversationData = response.data;
              // Preserve message order by keeping existing messages and only updating IDs
              setMessages(prev => {
                const existingMessages = [...prev];
                const serverMessages = conversationData.messages;
                
                // Update message IDs while maintaining order
                return existingMessages.map(msg => {
                  const serverMsg = serverMessages.find(
                    (sMsg: Message) => sMsg.role === msg.role && sMsg.content === msg.content
                  );
                  return serverMsg || msg;
                });
              });
            })
            .catch(error => {
              console.error("Error fetching conversation data:", error);
            });
        }
      }

      eventSource.onerror = () => {
        eventSource.close()
        setIsLoading(false)
        setMessages(prev => prev.map(msg => 
          msg.id === assistantMessageId.current ? { ...msg, isStreaming: false } : msg
        ))
      }

      // Reset form
      reset("message")
      setImageFiles([])
      setImagePreviews([])
      setExtractedText('')
      setExtractionStatus('')
      if (fileInputRef.current) fileInputRef.current.value = ""
    } catch (error) {
      console.error("Error starting stream:", error)
      setIsLoading(false)
      setMessages(prev => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          content: "Sorry, there was an error processing your request.",
          role: "assistant",
        },
      ])
    }
  }

  return (
    <AppSidebarLayout conversations={conversations} breadcrumbs={breadcrumbs}>
      <Head title="Chat" />
      <div className="flex h-[calc(100vh-8rem)] flex-col">
        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="flex-1 overflow-y-auto p-4">
            <div className="max-w-3xl mx-auto space-y-4">
              {messages.map((message) => (
                <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[80%] rounded-lg p-4 ${
                    message.role === "user" 
                      ? "bg-primary text-primary-foreground" 
                      : "bg-muted"
                    }`}>
                    <div className="whitespace-pre-wrap">
                      <ReactMarkdown>{message.content}</ReactMarkdown>
                      {message.isStreaming && (
                        <span className="inline-block ml-1">
                          <span className="animate-pulse">▋</span>
                        </span>
                      )}
                    </div>
                    {message.attachments?.map((attachment, i) => (
                      <div key={i} className="mt-2">
                        <img
                          src={attachment.url}
                          alt={`Attachment ${i}`}
                          className="max-w-[200px] max-h-[200px] rounded-md object-cover"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="border-t p-4 bg-background">
            <div className="max-w-3xl mx-auto">
              {imagePreviews.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {imagePreviews.map((preview, i) => (
                    <div key={i} className="relative h-12 w-12 rounded-md overflow-hidden">
                      <img src={preview} alt={`Preview ${i}`} className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removeImage(i)}
                        className="absolute top-0 right-0 bg-black/70 rounded-full p-0.5"
                      >
                        <X className="h-3 w-3 text-white" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {extractionStatus && (
                <div className="mb-2 p-2 bg-blue-100 dark:bg-green-900/30 text-blue-700 dark:text-blue-300 rounded text-sm flex items-center">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {extractionStatus}
                </div>
              )}

              <TooltipProvider>
                <form onSubmit={handleSubmit} className="flex items-center gap-2">
                  <div className="relative flex-1 flex items-center">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="absolute left-3 h-8 w-8"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={imageFiles.length >= 3 || isLoading || isExtracting}
                        >
                          <Image className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {imageFiles.length >= 3 ? "Maximum 3 images" : "Attach images"}
                      </TooltipContent>
                    </Tooltip>

                    <input
                      type="text"
                      value={data.message}
                      onChange={(e) => setData("message", e.target.value)}
                      placeholder="Type a message..."
                      className="w-full rounded-lg border border-input bg-background h-10 pl-12 pr-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      disabled={isLoading || isExtracting}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault()
                          const form = e.currentTarget.form
                          form?.requestSubmit()
                        }
                      }}
                    />

                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleImageSelect}
                      accept="image/*"
                      multiple
                      className="hidden"
                      disabled={imageFiles.length >= 3 || isLoading || isExtracting}
                    />
                  </div>

                  <Button
                    type="submit"
                    size="icon"
                    className="h-10 w-10"
                    disabled={isLoading || isExtracting || (!data.message.trim() && !imageFiles.length)}
                  >
                    {isLoading || isExtracting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </form>
              </TooltipProvider>

              <p className="text-xs text-muted-foreground mt-2">Press Enter to send</p>
            </div>
          </div>
        </div>
      </div>
    </AppSidebarLayout>
  )
}