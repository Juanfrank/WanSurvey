import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Put,
  Req,
  Res,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { AudioService, MAX_SEGMENT_BYTES } from './audio.service.js';

/**
 * The whole body of a request. Past the limit nothing more is kept (the rest is read and
 * thrown away, so the client gets its answer instead of a dropped connection).
 */
function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
      } else if (!over) chunks.push(c);
    });
    req.on('end', () =>
      over ? reject(new PayloadTooLargeException('Too large')) : resolve(Buffer.concat(chunks)),
    );
    req.on('error', reject);
  });
}

/** Interview recordings: segments up from the device, listening for reviewers (ADR 0001, 5). */
@ApiTags('audio')
@Controller()
export class AudioController {
  constructor(private readonly audio: AudioService) {}

  /** One segment of a recording (idempotent per interview and segment number). */
  @Put('interviews/:id/audio/:segment')
  @HttpCode(204)
  @RequirePermission('interviews.conduct', { anyProject: true })
  async upload(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('segment', ParseIntPipe) segment: number,
    @Headers('content-type') contentType: string | undefined,
    @Headers('x-duration-ms') duration: string | undefined,
    @Headers('x-sha256') sha256: string | undefined,
    @Req() req: Request,
  ) {
    const durationMs = Number(duration);
    if (!/^[0-9a-f]{64}$/i.test(sha256 ?? '') || !Number.isFinite(durationMs))
      throw new BadRequestException({
        code: 'BAD_HEADERS',
        message: 'x-sha256 and x-duration-ms are needed',
      });
    const body = await readBody(req, MAX_SEGMENT_BYTES);
    await this.audio.upload(ctx, id, segment, body, {
      // "audio/webm;codecs=opus" is audio/webm.
      contentType: (contentType ?? '').split(';')[0]!.trim().toLowerCase(),
      durationMs,
      sha256: sha256!,
    });
  }

  @Get('projects/:projectId/interviews/:id/audio')
  @RequirePermission('audio.listen', { projectParam: 'projectId' })
  list(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.audio.list(ctx, projectId, id);
  }

  /** The audio itself, streamed through the API with range support; never a signed link. */
  @Get('projects/:projectId/interviews/:id/audio/:segment')
  @RequirePermission('audio.listen', { projectParam: 'projectId' })
  async play(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('segment', ParseIntPipe) segment: number,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    const f = await this.audio.open(ctx, projectId, id, segment, range);
    res.status(f.partial ? 206 : 200);
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', f.end - f.start + 1);
    if (f.partial) res.setHeader('Content-Range', `bytes ${f.start}-${f.end}/${f.size}`);
    f.stream.pipe(res);
  }
}
