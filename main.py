# download the tool: yt-dlp
# pip install yt-dlp

import subprocess


def download_trimmed_youtube_video(video_url, start_time, end_time, output_filename):
    """
    Downloads a trimmed section of a YouTube video using yt-dlp.

    :param video_url: The URL of the YouTube video.
    :param start_time: Start time of the clip (format: HH:MM:SS or seconds).
    :param end_time: End time of the clip (format: HH:MM:SS or seconds).
    :param output_filename: The name of the output file (should end with .mp4).
    """
    command = [
        "yt-dlp",
        "--download-sections",
        f"*{start_time}-{end_time}",
        "-f",
        "mp4",
        "-o",
        output_filename,
        video_url,
    ]

    try:
        subprocess.run(command, check=True)
        print(f"Downloaded and trimmed video saved as: {output_filename}")
    except subprocess.CalledProcessError as e:
        print(f"Error in download_trimmed_youtube_Video function: {e}")


# Example usage
video_url = "https://www.youtube.com/watch?v=SyZEjWeUkPs"
start_time = "00:27:27"  # Start at 1 minute 30 seconds
end_time = "00:30:09"  # End at 2 minutes 45 seconds
output_filename = "sayyed_hassan_2.mp4"

download_trimmed_youtube_video(video_url, start_time, end_time, output_filename)
