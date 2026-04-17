import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.warn('[nexus] GEMINI_API_KEY not set — NEXUS will fail at runtime.');
}

export const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
export const NEXUS_MODEL = 'gemini-2.5-flash-lite';
