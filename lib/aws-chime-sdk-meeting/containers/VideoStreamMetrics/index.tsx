// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import React from "react";

import { useMediaStreamMetrics, useAudioVideo, PopOverHeader } from "amazon-chime-sdk-component-library-react";

import MediaStatsList from "../../components/MediaStatsList/index";
import MetricItem from "../../components/MediaStatsList/MetricItem";
import { StyledMediaMetricsWrapper } from "../../components/MediaStatsList/Styled";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isValidMetric(metric: any): metric is number {
  return typeof metric === "number" && !Number.isNaN(metric);
}

interface Props {
  /** The Chime attendee ID */
  attendeeId: string;
}

export const VideoStreamMetrics: React.FC<Props> = ({ attendeeId }) => {
  const audioVideo = useAudioVideo();
  const { videoStreamMetrics } = useMediaStreamMetrics();
  const streamMetric = videoStreamMetrics[attendeeId];
  const ssrcArray = streamMetric ? Object.keys(streamMetric) : [];
  const showMetric = audioVideo && attendeeId && streamMetric && ssrcArray.length !== 0;
  return (
    <StyledMediaMetricsWrapper>
      {showMetric && (
        <>
          <PopOverHeader title={"Video Statistics"} />
          <MediaStatsList>
            <MetricItem
              metricName="Bit rate (kbps)"
              metricValues={ssrcArray.map((ssrc) => {
                const metric = streamMetric[ssrc]?.["videoDownstreamBitrate"];
                return isValidMetric(metric) ? Math.trunc(metric / 1000).toString() : "";
              })}
            />
            <MetricItem
              metricName="Packet Loss"
              metricValues={ssrcArray.map((ssrc) => {
                const metric = streamMetric[ssrc]?.["videoDownstreamPacketLossPercent"];
                return isValidMetric(metric) ? Math.trunc(metric).toString() : "";
              })}
            />
            <MetricItem
              metricName="Frame Rate"
              metricValues={ssrcArray.map((ssrc) => {
                const metric = streamMetric[ssrc]?.["videoDownstreamFramesDecodedPerSecond"];
                return isValidMetric(metric) ? metric.toString() : "";
              })}
            />
            <MetricItem
              metricName="Frame Height"
              metricValues={ssrcArray.map((ssrc) => {
                const metric = streamMetric[ssrc]?.["videoDownstreamFrameHeight"];
                return isValidMetric(metric) ? metric.toString() : "";
              })}
            />
            <MetricItem
              metricName="Frame Width"
              metricValues={ssrcArray.map((ssrc) => {
                const metric = streamMetric[ssrc]?.["videoDownstreamFrameWidth"];
                return isValidMetric(metric) ? metric.toString() : "";
              })}
            />
            <MetricItem
              metricName="Bit rate (kbps)"
              metricValues={ssrcArray.map((ssrc) => {
                const metric = streamMetric[ssrc]?.["videoUpstreamBitrate"];
                return isValidMetric(metric) ? Math.trunc(metric / 1000).toString() : "";
              })}
            />
            <MetricItem
              metricName="Packets Sent"
              metricValues={ssrcArray.map((ssrc) => {
                const metric = streamMetric[ssrc]?.["videoUpstreamPacketsSent"];
                return isValidMetric(metric) ? metric.toString() : "";
              })}
            />
            <MetricItem
              metricName="Frame Rate"
              metricValues={ssrcArray.map((ssrc) => {
                const metric = streamMetric[ssrc]?.["videoUpstreamFramesEncodedPerSecond"];
                return isValidMetric(metric) ? metric.toString() : "";
              })}
            />
            <MetricItem
              metricName="Frame Height"
              metricValues={ssrcArray.map((ssrc) => {
                const metric = streamMetric[ssrc]?.["videoUpstreamFrameHeight"];
                return isValidMetric(metric) ? metric.toString() : "";
              })}
            />
            <MetricItem
              metricName="Frame Width"
              metricValues={ssrcArray.map((ssrc) => {
                const metric = streamMetric[ssrc]?.["videoUpstreamFrameWidth"];
                return isValidMetric(metric) ? metric.toString() : "";
              })}
            />
          </MediaStatsList>
        </>
      )}
    </StyledMediaMetricsWrapper>
  );
};

export default VideoStreamMetrics;
